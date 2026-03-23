/* ═══════════════════════════════════════════════════
   Cron Service — sends daily WhatsApp summary at 11 PM
   ═══════════════════════════════════════════════════ */

const cron    = require('node-cron');
const wa      = require('./whatsapp');
const summary = require('./dailySummary');

function start() {
  // Every day at 23:00 (11 PM)
  cron.schedule('0 23 * * *', async () => {
    const groupId = process.env.WHATSAPP_GROUP_ID;
    if (!groupId) {
      console.log('[Cron] WHATSAPP_GROUP_ID not set — skipping');
      return;
    }

    try {
      const message = await summary.buildWhatsAppMessage();
      await wa.sendToGroup(groupId, message);
      console.log('[Cron] Daily summary sent to WhatsApp ✅');
    } catch (err) {
      console.error('[Cron] Failed to send daily summary:', err.message);
    }
  }, { timezone: 'Asia/Kolkata' });

  console.log('[Cron] Daily WhatsApp summary scheduled at 11:00 PM IST ✅');
}

module.exports = { start };
