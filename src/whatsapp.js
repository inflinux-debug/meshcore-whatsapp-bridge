'use strict';

const EventEmitter = require('events');
const fs = require('fs');
const path = require('path');
const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcode = require('qrcode-terminal');

// Resolve o navegador a usar. Evita o download do Chromium do puppeteer
// (que costuma ser bloqueado por antivirus no Windows) reutilizando o
// Chrome/Edge ja instalado no sistema.
function resolveBrowserPath() {
  if (process.env.CHROME_PATH && fs.existsSync(process.env.CHROME_PATH)) {
    return process.env.CHROME_PATH;
  }
  const pf = process.env['ProgramFiles'] || 'C:\\Program Files';
  const pf86 = process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)';
  const local = process.env['LOCALAPPDATA'] || '';
  const candidates = [
    path.join(pf, 'Google\\Chrome\\Application\\chrome.exe'),
    path.join(pf86, 'Google\\Chrome\\Application\\chrome.exe'),
    local && path.join(local, 'Google\\Chrome\\Application\\chrome.exe'),
    path.join(pf86, 'Microsoft\\Edge\\Application\\msedge.exe'),
    path.join(pf, 'Microsoft\\Edge\\Application\\msedge.exe'),
  ].filter(Boolean);
  return candidates.find((p) => fs.existsSync(p)) || undefined;
}

/**
 * Wrapper sobre whatsapp-web.js: mantem a sessao logada (LocalAuth) e
 * envia mensagens para um numero de destino fixo.
 */
class WhatsAppSender extends EventEmitter {
  constructor({ target }) {
    super();
    if (!target) throw new Error('WHATSAPP_TARGET nao definido.');
    this.target = String(target).replace(/\D/g, ''); // so digitos
    this.chatId = null;
    this.ready = false;

    const executablePath = resolveBrowserPath();
    this._browserPath = executablePath;

    this.client = new Client({
      authStrategy: new LocalAuth({ clientId: 'meshcore-bridge2' }),
      puppeteer: {
        headless: true,
        executablePath, // usa Chrome/Edge do sistema; undefined = puppeteer decide
        args: ['--no-sandbox', '--disable-setuid-sandbox'],
      },
    });

    this.client.on('qr', (qr) => {
      this.emit('log', 'Escaneie o QR Code abaixo no WhatsApp do celular (Aparelhos conectados):');
      qrcode.generate(qr, { small: true });
    });

    this.client.on('authenticated', () => this.emit('log', 'WhatsApp autenticado.'));
    this.client.on('auth_failure', (m) => this.emit('error', new Error(`Falha de auth WhatsApp: ${m}`)));
    this.client.on('disconnected', (r) => {
      this.ready = false;
      this.chatId = null;
      this.emit('log', `WhatsApp desconectado: ${r}`);
      this.emit('disconnected', r);
    });

    this.client.on('ready', async () => {
      try {
        const numberId = await this.client.getNumberId(this.target);
        if (!numberId) {
          throw new Error(`Numero ${this.target} nao encontrado no WhatsApp.`);
        }
        this.chatId = numberId._serialized;
        this.ready = true;
        this.emit('log', `WhatsApp pronto. Destino: ${this.chatId}`);
        this.emit('ready');
      } catch (err) {
        this.emit('error', err);
      }
    });
  }

  async start() {
    this.emit('log', `Navegador: ${this._browserPath || '(padrao do puppeteer)'}`);
    this.emit('log', 'Inicializando WhatsApp Web (pode demorar na 1a vez)...');
    await this.client.initialize();
  }

  async send(text) {
    if (!this.ready || !this.chatId) {
      throw new Error('WhatsApp ainda nao esta pronto.');
    }
    await this.client.sendMessage(this.chatId, text);
  }

  async stop() {
    try { await this.client.destroy(); } catch (_) {}
  }
}

module.exports = { WhatsAppSender };
