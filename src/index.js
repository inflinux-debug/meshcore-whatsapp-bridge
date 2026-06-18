'use strict';

require('dotenv').config();

const { MeshCoreBLE } = require('./meshcore');
const { WhatsAppSender } = require('./whatsapp');

function ts() {
  return new Date().toISOString().replace('T', ' ').slice(0, 19);
}
function log(scope, msg) {
  console.log(`[${ts()}] [${scope}] ${msg}`);
}

async function main() {
  const target = process.env.WHATSAPP_TARGET;
  const prefix = process.env.MESSAGE_PREFIX || '';

  const wa = new WhatsAppSender({ target });
  wa.on('log', (m) => log('WA', m));
  wa.on('error', (e) => log('WA', `ERRO: ${e.message}`));

  const mesh = new MeshCoreBLE({
    deviceName: process.env.MESHCORE_DEVICE_NAME,
    deviceId: process.env.MESHCORE_DEVICE_ID,
    appName: process.env.APP_NAME || 'wa-bridge',
    pollIntervalMs: Number(process.env.MESHCORE_POLL_MS) || 4000,
  });
  mesh.on('log', (m) => log('MESH', m));
  mesh.on('error', (e) => log('MESH', `ERRO: ${e.message}`));
  mesh.on('connected', () => log('MESH', 'Login concluido no radio MeshCore.'));
  mesh.on('disconnected', () => log('MESH', 'Radio desconectado.'));

  // Fila com limite, drenada quando o WhatsApp estiver pronto.
  const MAX_QUEUE = 500;
  const pending = [];
  let waReady = false;
  let flushing = false;

  function enqueue(text) {
    pending.push(text);
    if (pending.length > MAX_QUEUE) {
      const dropped = pending.shift();
      log('BRIDGE', `Fila cheia (${MAX_QUEUE}); descartando a mais antiga: ${dropped}`);
    }
  }

  // Drena a fila sem reentrancia. Em caso de falha de envio, MANTEM a
  // mensagem na fila e para (sera retentada depois) — sem loop infinito.
  async function flushQueue() {
    if (flushing) return;
    flushing = true;
    try {
      while (waReady && pending.length) {
        const text = pending[0];
        const body = (prefix ? prefix + ' ' : '') + text;
        try {
          await wa.send(body);
          pending.shift();
          log('BRIDGE', `Encaminhado p/ WhatsApp: ${text}`);
        } catch (err) {
          log('BRIDGE', `Falha ao enviar (sera retentada): ${err.message}`);
          break;
        }
      }
    } finally {
      flushing = false;
    }
  }

  mesh.on('message', (m) => {
    const origin = m.type === 'channel' ? `canal#${m.channel}` : `contato ${m.pubkeyPrefix}`;
    log('MESH', `Mensagem recebida (${origin}): ${m.text}`);
    enqueue(m.text);
    if (waReady) flushQueue();
    else log('BRIDGE', 'WhatsApp ainda nao pronto; mensagem na fila.');
  });

  wa.on('ready', () => {
    waReady = true;
    flushQueue();
  });
  wa.on('disconnected', () => {
    waReady = false;
    log('BRIDGE', 'WhatsApp caiu; mensagens ficarao na fila ate reconectar.');
  });

  // Rede de seguranca: retenta a fila periodicamente caso envios falhem e
  // nenhuma mensagem nova chegue para disparar o flush.
  const retryTimer = setInterval(() => {
    if (waReady && pending.length) flushQueue();
  }, 15000);

  // Encerramento limpo (com saida forcada se algo travar).
  const shutdown = async () => {
    log('BRIDGE', 'Encerrando...');
    clearInterval(retryTimer);
    setTimeout(() => process.exit(0), 5000).unref();
    await mesh.stop();
    await wa.stop();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  // Sobe os dois servicos. Se algo falhar aqui (ex.: WhatsApp Web), encerra o
  // navegador/BLE antes de propagar — senao o Chrome do puppeteer fica orfao
  // segurando o perfil em .wwebjs_auth, e a proxima execucao colide nele.
  try {
    await wa.start();
    await mesh.start();
  } catch (err) {
    await wa.stop().catch(() => {});
    await mesh.stop().catch(() => {});
    throw err;
  }
  log('BRIDGE', 'Ponte ativa. Aguardando mensagens do MeshCore...');
}

main().catch((err) => {
  console.error('Erro fatal:', err);
  process.exit(1);
});
