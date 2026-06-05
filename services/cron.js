/* ═══════════════════════════════════════════════════
   Cron Service — sends daily WhatsApp summary at 11 PM
   Chrome starts at 11 PM, sends report, then shuts down.
   ═══════════════════════════════════════════════════ */

const cron    = require('node-cron');
const wa      = require('./whatsapp');
const summary = require('./dailySummary');

/* ─── Warmup: keep WhatsApp connected all day so 11 PM send just works ─── */
function warmup() {
  // Connect at server boot and keep the session alive.
  // whatsapp-web.js uses LocalAuth so the QR only needs scanning once.
  try {
    wa.init();
    console.log('[Cron] WhatsApp warmup started at boot');
  } catch (err) {
    console.error('[Cron] WhatsApp warmup error:', err.message);
  }
}

/* ─── The actual send, with retries ─── */
async function sendDailySummary(attempt = 1) {
  const raw     = (process.env.WHATSAPP_GROUP_ID || '').trim();
  const match   = raw.match(/(\d+@g\.us)/);
  const groupId = match ? match[1] : raw;
  if (!groupId) {
    console.log('[Cron] WHATSAPP_GROUP_ID not set — skipping');
    return;
  }

  console.log(`[Cron] Daily summary attempt ${attempt}/3 …`);
  try {
    // Make sure client is alive (LocalAuth will resume without QR scan).
    wa.init();
    await wa.waitReady(120000);

    const message = await summary.buildWhatsAppMessage();
    await wa.sendToGroup(groupId, message);
    console.log('[Cron] Daily summary sent ✅');
  } catch (err) {
    console.error(`[Cron] Send failed (attempt ${attempt}):`, err.message);
    if (attempt < 3) {
      const delayMs = 5 * 60 * 1000; // retry after 5 min
      console.log(`[Cron] Retrying in 5 min…`);
      setTimeout(() => sendDailySummary(attempt + 1), delayMs);
    } else {
      console.error('[Cron] All 3 attempts failed — summary NOT sent today');
    }
  }
  // NOTE: no destroy() — we keep the session alive for tomorrow.
}

function start() {
  // WhatsApp disabled — all cron jobs suspended
  console.log('[Cron] WhatsApp disabled — no jobs scheduled');
}

module.exports = { start };
