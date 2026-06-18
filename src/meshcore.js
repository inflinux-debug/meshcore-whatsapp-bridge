'use strict';

const EventEmitter = require('events');
const noble = require('@stoprocent/noble');

// Nordic UART Service (NUS) usado pelo firmware companion do MeshCore.
// noble usa UUIDs em minusculas e sem hifens.
const NUS_SERVICE = '6e400001b5a3f393e0a9e50e24dcca9e';
const NUS_RX = '6e400002b5a3f393e0a9e50e24dcca9e'; // app -> radio (write)
const NUS_TX = '6e400003b5a3f393e0a9e50e24dcca9e'; // radio -> app (notify)

// Comandos (app -> radio)
const CMD_APP_START = 0x01;
const CMD_SYNC_NEXT_MESSAGE = 0x0a;

// Respostas / pushes (radio -> app)
const RESP_OK = 0x00;
const RESP_SELF_INFO = 0x05;
const RESP_CONTACT_MSG_RECV = 0x07; // mensagem direta de contato
const RESP_CHANNEL_MSG_RECV = 0x08; // mensagem de canal
const RESP_NO_MORE_MSGS = 0x0a;
const RESP_CONTACT_MSG_RECV_V3 = 0x10; // mesmo que 0x07 mas com SNR no inicio

const PUSH_MSG_WAITING = 0x83; // ha mensagens na fila do radio

// Pushes de rede/diagnostico (0x80-0x8A): trafego de fundo da malha
// (adverts, path updates, log de RX, etc.). Nao sao mensagens de chat.
const PUSH_NAMES = {
  0x80: 'advert',
  0x81: 'path-updated',
  0x82: 'send-confirmed',
  0x84: 'raw-data',
  0x85: 'login-ok',
  0x86: 'login-fail',
  0x87: 'status',
  0x88: 'rx-log',
  0x89: 'trace',
  0x8a: 'novo-advert',
};

/**
 * Conecta ao radio MeshCore por BLE, faz login e emite eventos 'message'
 * com { text, pubkeyPrefix, timestamp, type } para cada mensagem recebida.
 */
class MeshCoreBLE extends EventEmitter {
  constructor({ deviceName = '', deviceId = '', appName = 'wa-bridge', pollIntervalMs = 4000 } = {}) {
    super();
    this.deviceName = (deviceName || '').trim();
    this.deviceId = (deviceId || '').trim().toLowerCase().replace(/[:\-]/g, '');
    this.appName = appName;
    this.pollIntervalMs = pollIntervalMs;
    this.peripheral = null;
    this.rxChar = null; // escrita
    this.txChar = null; // notificacao
    this._draining = false;
    this._drainWatch = null;
    this._pollTimer = null;
    this._writeChain = null;
    this._wantStop = false;
  }

  async start() {
    this._wantStop = false;
    noble.on('stateChange', (state) => {
      if (state === 'poweredOn') {
        this.emit('log', 'Bluetooth ligado. Procurando dispositivo MeshCore...');
        this._startScan();
      } else {
        this.emit('log', `Estado do Bluetooth: ${state}`);
      }
    });

    noble.on('discover', (peripheral) => this._onDiscover(peripheral));

    if (noble.state === 'poweredOn') {
      this._startScan();
    }
  }

  // @stoprocent/noble: startScanning e callback-based; use a variante async.
  // Alguns adaptadores nao filtram por servico no advert -> fallback sem filtro.
  async _startScan() {
    if (this._wantStop || this.peripheral) return;
    try {
      await noble.startScanningAsync([NUS_SERVICE], false);
    } catch (_) {
      try {
        await noble.startScanningAsync([], false);
      } catch (err) {
        this.emit('error', err);
      }
    }
  }

  async stop() {
    this._wantStop = true;
    try { await noble.stopScanningAsync(); } catch (_) {}
    if (this.peripheral) {
      try { await this.peripheral.disconnectAsync(); } catch (_) {}
    }
  }

  _matches(peripheral) {
    const adv = peripheral.advertisement || {};
    const name = (adv.localName || '').trim();
    const id = (peripheral.id || '').toLowerCase();
    if (this.deviceId) return id === this.deviceId;
    if (this.deviceName) return name.toLowerCase().includes(this.deviceName.toLowerCase());
    // sem filtro: aceita qualquer um que anuncie o servico NUS
    const services = (adv.serviceUuids || []).map((u) => u.toLowerCase().replace(/-/g, ''));
    return services.includes(NUS_SERVICE) || name.length > 0;
  }

  async _onDiscover(peripheral) {
    if (this.peripheral) return; // ja conectado/conectando
    if (!this._matches(peripheral)) return;

    const name = (peripheral.advertisement.localName || '(sem nome)').trim();
    this.emit('log', `Dispositivo encontrado: ${name} [${peripheral.id}]`);
    this.peripheral = peripheral;

    try {
      await noble.stopScanningAsync();
      await peripheral.connectAsync();
      this.emit('log', 'Conectado por BLE. Descobrindo caracteristicas...');

      const { characteristics } = await peripheral.discoverSomeServicesAndCharacteristicsAsync(
        [NUS_SERVICE],
        [NUS_RX, NUS_TX]
      );

      for (const c of characteristics) {
        const uuid = c.uuid.toLowerCase();
        if (uuid === NUS_RX) this.rxChar = c;
        if (uuid === NUS_TX) this.txChar = c;
      }

      if (!this.rxChar || !this.txChar) {
        throw new Error('Caracteristicas NUS (RX/TX) nao encontradas no dispositivo.');
      }

      this.txChar.on('data', (data) => this._onFrame(data));
      await this.txChar.subscribeAsync();

      peripheral.once('disconnect', () => this._onDisconnect());

      // Login no radio
      await this._appStart();
      this.emit('connected');

      // Drena mensagens que ja estavam na fila
      this._drain();

      // Poll periodico: alguns firmwares nao reenviam MSG_WAITING de forma
      // confiavel, entao pedimos mensagens regularmente como rede de seguranca.
      this._pollTimer = setInterval(() => this._drain(), this.pollIntervalMs);
    } catch (err) {
      this.emit('error', err);
      await this._onDisconnect();
    }
  }

  async _onDisconnect() {
    if (this._pollTimer) { clearInterval(this._pollTimer); this._pollTimer = null; }
    this._endDrain();
    if (this.peripheral) {
      try { this.peripheral.removeAllListeners('disconnect'); } catch (_) {}
    }
    if (this.txChar) {
      try { this.txChar.removeAllListeners('data'); } catch (_) {}
    }
    this.peripheral = null;
    this.rxChar = null;
    this.txChar = null;
    this.emit('disconnected');

    if (!this._wantStop) {
      this.emit('log', 'Desconectado. Tentando reconectar em 5s...');
      setTimeout(() => this._startScan(), 5000);
    }
  }

  // Serializa as escritas: o poll e a cadeia de leitura podem chamar _write
  // ao mesmo tempo; escritas GATT concorrentes falham em alguns adaptadores.
  async _write(buf) {
    this._writeChain = (this._writeChain || Promise.resolve())
      .catch(() => {})
      .then(() => {
        if (!this.rxChar) throw new Error('RX nao disponivel');
        // withoutResponse=false: mais confiavel para frames de comando
        return this.rxChar.writeAsync(buf, false);
      });
    return this._writeChain;
  }

  async _appStart() {
    // Byte0=0x01, bytes 1-7 reservados, depois nome do app (UTF-8)
    const header = Buffer.alloc(8, 0);
    header[0] = CMD_APP_START;
    const name = Buffer.from(this.appName, 'utf8');
    await this._write(Buffer.concat([header, name]));
    this.emit('log', 'Login enviado (CMD_APP_START).');
  }

  async _getNextMessage() {
    await this._write(Buffer.from([CMD_SYNC_NEXT_MESSAGE]));
  }

  // Inicia o ciclo de leitura: pede a proxima mensagem, se ja nao estiver
  // pedindo. O watchdog garante que a flag nunca fique presa.
  _drain() {
    if (this._draining) return;
    this._draining = true;
    this._requestNext();
  }

  // Pede a proxima mensagem e arma o watchdog para liberar o latch caso
  // o radio nao responda (ex.: firmware que nao envia "nao ha mais").
  _requestNext() {
    this._armWatchdog();
    this._getNextMessage().catch((err) => {
      this.emit('error', err);
      this._endDrain();
    });
  }

  _armWatchdog() {
    clearTimeout(this._drainWatch);
    this._drainWatch = setTimeout(() => this._endDrain(), 3000);
  }

  _endDrain() {
    clearTimeout(this._drainWatch);
    this._drainWatch = null;
    this._draining = false;
  }

  _hex(data) {
    return Buffer.from(data).toString('hex').replace(/(..)/g, '$1 ').trim();
  }

  _onFrame(data) {
    if (!data || data.length === 0) return;
    const code = data[0];

    switch (code) {
      case PUSH_MSG_WAITING:
        // O radio avisa que ha mensagens; comeca a drenar.
        this._drain();
        break;

      case RESP_CONTACT_MSG_RECV:
        this._handleContactMsg(data, 1, false);
        this._requestNext();
        break;

      case RESP_CONTACT_MSG_RECV_V3:
        this._handleContactMsg(data, 4, true);
        this._requestNext();
        break;

      case RESP_CHANNEL_MSG_RECV:
        // Mensagem de canal: estrutura parecida, tratada de forma simples.
        this._handleChannelMsg(data);
        this._requestNext();
        break;

      case RESP_NO_MORE_MSGS:
        this._endDrain();
        break;

      case RESP_SELF_INFO:
        this.emit('log', 'SELF_INFO recebido (radio identificado).');
        break;

      case RESP_OK:
        // ignorado
        break;

      default:
        if (code >= 0x80) {
          // Push de rede/diagnostico: log curto (nao e mensagem de chat).
          const name = PUSH_NAMES[code] || 'push';
          const node = this._trailingName(data);
          this.emit('log', `Trafego de rede: ${name}${node ? ` (${node})` : ''} [0x${code.toString(16)}]`);
        } else {
          // code < 0x80 inesperado: pode ser formato de mensagem deste
          // firmware. Registra em hex para diagnostico.
          this.emit('log', `Frame nao tratado code=0x${code.toString(16).padStart(2, '0')} (${data.length}B): ${this._hex(data)}`);
          if (this._draining) this._endDrain();
        }
    }
  }

  // Extrai o nome do no (ASCII imprimivel no final do frame de advert).
  _trailingName(data) {
    let end = data.length;
    let start = end;
    for (let i = end - 1; i >= 0; i--) {
      const b = data[i];
      if (b >= 0x20 && b <= 0x7e) start = i;
      else break;
    }
    const s = data.slice(start, end).toString('utf8').trim();
    return s.length >= 3 ? s : '';
  }

  // offset: posicao onde comeca o prefixo de pubkey (depois do header opcional de SNR)
  _handleContactMsg(data, offset, hasSnr) {
    try {
      let p = offset;
      const pubkeyPrefix = data.slice(p, p + 6).toString('hex'); p += 6;
      const pathLen = data[p]; p += 1; // eslint-disable-line no-unused-vars
      const txtType = data[p]; p += 1;
      const timestamp = data.readUInt32LE(p); p += 4;
      if (txtType === 2) p += 4; // assinatura, quando presente
      const text = data.slice(p).toString('utf8').replace(/\0+$/, '');
      const snr = hasSnr ? (data.readInt8(1) / 4) : null;

      if (text.length === 0) return;
      this.emit('message', {
        text,
        pubkeyPrefix,
        timestamp,
        type: 'contact',
        snr,
      });
    } catch (err) {
      this.emit('error', new Error(`Falha ao decodificar mensagem de contato: ${err.message}`));
    }
  }

  _handleChannelMsg(data) {
    try {
      // [0]=code, [1]=channel idx, [2]=txt type, [3..6]=timestamp, [7..]=texto
      const channel = data[1];
      const timestamp = data.readUInt32LE(3);
      const text = data.slice(7).toString('utf8').replace(/\0+$/, '');
      if (text.length === 0) return;
      this.emit('message', {
        text,
        channel,
        timestamp,
        type: 'channel',
        snr: null,
      });
    } catch (err) {
      this.emit('error', new Error(`Falha ao decodificar mensagem de canal: ${err.message}`));
    }
  }
}

module.exports = { MeshCoreBLE };
