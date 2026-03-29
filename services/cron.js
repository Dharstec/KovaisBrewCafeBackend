/* ═══════════════════════════════════════════════════
   Cron Service — sends daily WhatsApp summary at 11 PM
   Chrome starts at 11 PM, sends report, then shuts down.
   ═══════════════════════════════════════════════════ */

const cron    = require('node-cron');
const wa      = require('./whatsapp');
const summary = require('./dailySummary');

function start() {
  cron.schedule('0 23 * * *', async () => {
    const raw     = (process.env.WHATSAPP_GROUP_ID || '').trim();
    const match   = raw.match(/(\d+@g\.us)/);
    const groupId = match ? match[1] : raw;
    if (!groupId) {
      console.log('[Cron] WHATSAPP_GROUP_ID not set — skipping');
      return;
    }

    console.log('[Cron] 11 PM — starting WhatsApp for daily summary…');

    try {
      wa.init();                    // launch Chrome
      await wa.waitReady(90000);    // wait up to 90s for connection

      const message = await summary.buildWhatsAppMessage();
      await wa.sendToGroup(groupId, message);
      console.log('[Cron] Daily summary sent ✅');
    } catch (err) {
      console.error('[Cron] Failed to send daily summary:', err.message);
    } finally {
      await wa.destroy();           // shut Chrome down
      console.log('[Cron] WhatsApp closed after sending');
    }
  }, { timezone: 'Asia/Kolkata' });

  console.log('[Cron] Daily WhatsApp summary scheduled at 11:00 PM IST ✅');
}

module.exports = { start };
