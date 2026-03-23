/* ═══════════════════════════════════════════════════
   Daily Summary — fetch today's data and format
   as a WhatsApp message for the shop group
   ═══════════════════════════════════════════════════ */

const DB = require('../middleware/dbFunctions');

async function getTodaySummary() {
  // Sales
  const sales = await DB.PostgresAny(`
    SELECT
      COUNT(*)                         AS total_bills,
      COALESCE(SUM(grand_total), 0)    AS total_sales,
      COALESCE(SUM(grand_total) FILTER (WHERE payment_mode = 'CASH'), 0) AS cash_total,
      COALESCE(SUM(grand_total) FILTER (WHERE payment_mode = 'UPI'),  0) AS upi_total
    FROM bills
    WHERE status = 'COMPLETED'
      AND DATE(created_at) = CURRENT_DATE
  `);

  // Expenses
  const TABLE_SPENT = process.env.TABLE_SPENT || 'spent';
  const expenses = await DB.PostgresAny(`
    SELECT COALESCE(SUM(amount), 0) AS total_expense
    FROM ${TABLE_SPENT}
    WHERE date::date = CURRENT_DATE
  `);

  const totalSales   = Number(sales[0].total_sales);
  const cashTotal    = Number(sales[0].cash_total);
  const upiTotal     = Number(sales[0].upi_total);
  const totalBills   = Number(sales[0].total_bills);
  const totalExpense = Number(expenses[0].total_expense);
  const inHand       = totalSales - totalExpense;

  return { totalSales, cashTotal, upiTotal, totalBills, totalExpense, inHand };
}

function fmt(n) {
  return '₹' + n.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

async function buildWhatsAppMessage() {
  const d = await getTodaySummary();

  const today = new Date().toLocaleDateString('en-IN', {
    weekday: 'long', day: '2-digit', month: 'short', year: 'numeric'
  });

  return (
`☕ *Kovai's Brew Café — Daily Report*
📅 ${today}
━━━━━━━━━━━━━━━━━━━━

💰 *Sales Summary*
   💵 Cash    : ${fmt(d.cashTotal)}
   📲 UPI     : ${fmt(d.upiTotal)}
   🧾 Bills   : ${d.totalBills}
   ✅ Total Sales : *${fmt(d.totalSales)}*

━━━━━━━━━━━━━━━━━━━━
💸 *Expenses*
   🔴 Total Spend : ${fmt(d.totalExpense)}

━━━━━━━━━━━━━━━━━━━━
🏦 *Net In Hand*
   💚 *${fmt(d.inHand)}*
━━━━━━━━━━━━━━━━━━━━
_Sent automatically at 11:00 PM_`
  );
}

module.exports = { getTodaySummary, buildWhatsAppMessage };
