/* ═══════════════════════════════════════════════════
   WhatsApp Service — whatsapp-web.js
   ═══════════════════════════════════════════════════ */

const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcode = require('qrcode');

let currentQR   = null;
let isReady     = false;
let initError   = null;
let initStarted = false;

// Use system Chrome — no bundled Chromium in this project
const CHROME_PATH = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

const client = new Client({
  authStrategy: new LocalAuth({ dataPath: '.wwebjs_auth' }),
  puppeteer: {
    headless: true,
    executablePath: CHROME_PATH,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-accelerated-2d-canvas',
      '--no-first-run',
      '--no-zygote',
      '--disable-gpu'
    ]
  }
});

client.on('qr', async (qr) => {
  isReady   = false;
  initError = null;
  try {
    currentQR = await qrcode.toDataURL(qr);
    console.log('[WhatsApp] QR code ready — scan from dashboard');
  } catch (e) {
    console.error('[WhatsApp] QR generation error:', e);
  }
});

client.on('ready', () => {
  isReady   = true;
  currentQR = null;
  initError = null;
  console.log('[WhatsApp] Client ready ✅');
});

client.on('authenticated', () => {
  currentQR = null;
  console.log('[WhatsApp] Authenticated ✅');
});

client.on('auth_failure', (msg) => {
  isReady   = false;
  currentQR = null;
  initError = 'Auth failed: ' + msg;
  console.error('[WhatsApp] Auth failure:', msg);
});

client.on('disconnected', (reason) => {
  isReady   = false;
  console.log('[WhatsApp] Disconnected:', reason);
  setTimeout(() => client.initialize().catch(console.error), 5000);
});

function init() {
  if (initStarted) return;
  initStarted = true;
  console.log('[WhatsApp] Initializing (launching Chromium)…');
  client.initialize().catch(err => {
    initError = err.message;
    console.error('[WhatsApp] init error:', err.message);
  });
}

async function sendToGroup(groupId, message) {
  if (!isReady) throw new Error('WhatsApp not connected');
  await client.sendMessage(groupId, message);
}

async function getGroups() {
  if (!isReady) throw new Error('WhatsApp not connected');
  const chats = await client.getChats();
  return chats
    .filter(c => c.isGroup)
    .map(c => ({ id: c.id._serialized, name: c.name }));
}

module.exports = {
  init,
  getQR:      () => ({ qr: currentQR, ready: isReady, error: initError }),
  sendToGroup,
  getGroups,
};
