/* ═══════════════════════════════════════════════════
   WhatsApp Service — whatsapp-web.js
   Starts on demand (cron at 11 PM or admin QR page).
   Destroys after sending to free Chrome memory.
   ═══════════════════════════════════════════════════ */

const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcode   = require('qrcode');
const puppeteer = require('puppeteer');
const fs        = require('fs');

let client      = null;
let currentQR   = null;
let isReady     = false;
let initError   = null;
let initStarted = false;

function resolveChromePath() {
  try {
    const p = puppeteer.executablePath();
    if (p && fs.existsSync(p)) return p;
  } catch (_) {}

  const linuxPaths = [
    '/usr/bin/google-chrome',
    '/usr/bin/google-chrome-stable',
    '/usr/bin/chromium-browser',
    '/usr/bin/chromium',
    '/snap/bin/chromium',
  ];
  for (const p of linuxPaths) {
    if (fs.existsSync(p)) return p;
  }

  const macPath = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
  if (fs.existsSync(macPath)) return macPath;

  return null;
}

const CHROME_PATH = resolveChromePath();

function createClient() {
  return new Client({
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
}

function init() {
  if (initStarted) return;
  initStarted = true;
  isReady     = false;
  currentQR   = null;
  initError   = null;

  client = createClient();

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
    isReady = false;
    console.log('[WhatsApp] Disconnected:', reason, '— will auto-reconnect in 30s');
    // Silent auto-reconnect so the 11 PM cron finds a live session
    try { client && client.destroy().catch(() => {}); } catch (_) {}
    client      = null;
    initStarted = false;
    setTimeout(() => { try { init(); } catch (_) {} }, 30000);
  });

  console.log('[WhatsApp] Initializing (launching Chromium)…');
  client.initialize().catch(err => {
    initError = err.message;
    console.error('[WhatsApp] init error:', err.message);
  });
}

/* Wait until ready or timeout (ms) */
function waitReady(timeoutMs = 60000) {
  return new Promise((resolve, reject) => {
    if (isReady) return resolve();
    const deadline = Date.now() + timeoutMs;
    const check = setInterval(() => {
      if (isReady) {
        clearInterval(check);
        return resolve();
      }
      if (initError) {
        clearInterval(check);
        return reject(new Error(initError));
      }
      if (Date.now() > deadline) {
        clearInterval(check);
        return reject(new Error('WhatsApp init timed out after ' + timeoutMs / 1000 + 's'));
      }
    }, 500);
  });
}

/* Destroy client and free Chrome memory */
async function destroy() {
  if (!client) return;
  try {
    await client.destroy();
    console.log('[WhatsApp] Client destroyed — Chrome closed ✅');
  } catch (e) {
    console.error('[WhatsApp] destroy error:', e.message);
  } finally {
    client      = null;
    isReady     = false;
    currentQR   = null;
    initError   = null;
    initStarted = false;
  }
}

async function sendToGroup(groupId, message) {
  if (!isReady) throw new Error('WhatsApp not connected');
  const id = groupId.trim();
  if (!id.includes('@')) {
    throw new Error(`Invalid chat ID: "${id}". Must end with @g.us`);
  }
  try {
    await client.sendMessage(id, message);
  } catch (err) {
    console.log('[WhatsApp] First attempt failed, retrying in 3s…');
    await new Promise(r => setTimeout(r, 3000));
    await client.sendMessage(id, message);
  }
}

async function getGroups() {
  if (!isReady) throw new Error('WhatsApp not connected');
  const chats = await client.getChats();
  return chats
    .filter(c => c.isGroup)
    .map(c => {
      const raw   = c.id._serialized || '';
      const match = raw.match(/(\d+@g\.us)/);
      const id    = match ? match[1] : raw;
      return { id, name: c.name };
    });
}

module.exports = {
  init,
  waitReady,
  destroy,
  getQR:      () => ({ qr: currentQR, ready: isReady, error: initError }),
  sendToGroup,
  getGroups,
};
