/* ═══════════════════════════════════════════════════
   Daily Summary — fetch today's data and format
   as a WhatsApp message for the shop group.

   Includes:
     - Cash / UPI / Zomato / Swiggy totals
     - Zomato & Swiggy 30% commission → net revenue
     - Pending (un-settled) bills
     - Expenses
     - Net in hand  (actual revenue − expenses)
   ═══════════════════════════════════════════════════ */

const DB = require('../middleware/dbFunctions');

async function getTodaySummary() {
  /* Completed sales broken down by payment mode & platform */
  const sales = await DB.PostgresAny(`
    SELECT
      COUNT(*) FILTER (WHERE status = 'COMPLETED')                              AS total_bills,
      COALESCE(SUM(grand_total) FILTER (WHERE status = 'COMPLETED'),          0) AS total_sales,

      COALESCE(SUM(grand_total) FILTER (WHERE status='COMPLETED' AND payment_mode='CASH'),   0) AS cash_total,
      COALESCE(SUM(grand_total) FILTER (WHERE status='COMPLETED' AND payment_mode='UPI'),    0) AS upi_total,

      COALESCE(SUM(grand_total) FILTER (WHERE status='COMPLETED' AND LOWER(platform)='zomato'), 0) AS zomato_total,
      COALESCE(SUM(grand_total) FILTER (WHERE status='COMPLETED' AND LOWER(platform)='swiggy'), 0) AS swiggy_total,

      COUNT(*) FILTER (WHERE status = 'PENDING')                                AS pending_count,
      COALESCE(SUM(grand_total) FILTER (WHERE status = 'PENDING'),            0) AS pending_total
    FROM bills
    WHERE DATE(created_at) = CURRENT_DATE
  `);

  /* Expenses */
  const TABLE_SPENT = process.env.TABLE_SPENT || 'spent';
  const expenses = await DB.PostgresAny(
    `SELECT COALESCE(SUM(amount), 0) AS total_expense
       FROM ${TABLE_SPENT}
      WHERE date::date = CURRENT_DATE`
  );

  const r = sales[0];
  const totalBills   = Number(r.total_bills);
  const totalSales   = Number(r.total_sales);
  const cashTotal    = Number(r.cash_total);
  const upiTotal     = Number(r.upi_total);
  const zomatoGross  = Number(r.zomato_total);
  const swiggyGross  = Number(r.swiggy_total);
  const pendingCount = Number(r.pending_count);
  const pendingTotal = Number(r.pending_total);

  // Aggregator 30% commission — shop receives 70%.
  const zomatoNet = +(zomatoGross * 0.70).toFixed(2);
  const swiggyNet = +(swiggyGross * 0.70).toFixed(2);
  const zomatoCut = +(zomatoGross - zomatoNet).toFixed(2);
  const swiggyCut = +(swiggyGross - swiggyNet).toFixed(2);

  const regular      = cashTotal + upiTotal;                  // direct walk-in
  const actualRevenue = +(regular + zomatoNet + swiggyNet).toFixed(2);

  const totalExpense = Number(expenses[0].total_expense);
  const inHand       = +(actualRevenue - totalExpense).toFixed(2);

  return {
    totalBills, totalSales,
    cashTotal, upiTotal,
    zomatoGross, swiggyGross,
    zomatoNet,   swiggyNet,
    zomatoCut,   swiggyCut,
    regular, actualRevenue,
    pendingCount, pendingTotal,
    totalExpense, inHand,
  };
}

function fmt(n) {
  return '₹' + Number(n || 0).toLocaleString('en-IN', {
    minimumFractionDigits: 2, maximumFractionDigits: 2,
  });
}

async function buildWhatsAppMessage() {
  const d = await getTodaySummary();

  const today = new Date().toLocaleDateString('en-IN', {
    weekday: 'long', day: '2-digit', month: 'short', year: 'numeric',
  });

  const lines = [];
  lines.push(`☕ *Kovai's Brew Café — Daily Report*`);
  lines.push(`📅 ${today}`);
  lines.push(`━━━━━━━━━━━━━━━━━━━━`);

  /* Direct sales */
  lines.push(`💰 *Direct Sales*`);
  lines.push(`   💵 Cash   : ${fmt(d.cashTotal)}`);
  lines.push(`   📲 UPI    : ${fmt(d.upiTotal)}`);
  lines.push(`   🔸 Sub-total : *${fmt(d.regular)}*`);

  /* Aggregators — only if any */
  if (d.zomatoGross > 0 || d.swiggyGross > 0) {
    lines.push(`━━━━━━━━━━━━━━━━━━━━`);
    lines.push(`🛵 *Aggregators* _(30% commission)_`);
    if (d.zomatoGross > 0) {
      lines.push(`   🔴 Zomato : ${fmt(d.zomatoGross)}  →  Net ${fmt(d.zomatoNet)}  (−${fmt(d.zomatoCut)})`);
    }
    if (d.swiggyGross > 0) {
      lines.push(`   🟠 Swiggy : ${fmt(d.swiggyGross)}  →  Net ${fmt(d.swiggyNet)}  (−${fmt(d.swiggyCut)})`);
    }
  }

  /* Totals */
  lines.push(`━━━━━━━━━━━━━━━━━━━━`);
  lines.push(`🧾 Bills today : *${d.totalBills}*`);
  lines.push(`📊 Gross Sales : *${fmt(d.totalSales)}*`);
  lines.push(`💎 Actual Revenue : *${fmt(d.actualRevenue)}*`);
  lines.push(`_(Cash + UPI + Zomato net + Swiggy net)_`);

  /* Pending */
  if (d.pendingCount > 0) {
    lines.push(`━━━━━━━━━━━━━━━━━━━━`);
    lines.push(`⏳ *Pending Bills* : ${d.pendingCount}  (${fmt(d.pendingTotal)})`);
  }

  /* Expenses */
  lines.push(`━━━━━━━━━━━━━━━━━━━━`);
  lines.push(`💸 *Expenses Today* : ${fmt(d.totalExpense)}`);

  /* In hand */
  lines.push(`━━━━━━━━━━━━━━━━━━━━`);
  lines.push(`🏦 *Net In Hand*`);
  lines.push(`   💚 *${fmt(d.inHand)}*`);
  lines.push(`━━━━━━━━━━━━━━━━━━━━`);
  lines.push(`_Sent automatically at 11:00 PM_`);

  return lines.join('\n');
}

module.exports = { getTodaySummary, buildWhatsAppMessage };
