const DB      = require("../middleware/dbFunctions");
const wa      = require("../services/whatsapp");
const summary = require("../services/dailySummary");

/* ─────────────────────────────────────────
   HELPER — resolve the date param
   Falls back to CURRENT_DATE if not provided
   ───────────────────────────────────────── */
function resolveDate(req) {
  const d = req.query.date;
  if (d && /^\d{4}-\d{2}-\d{2}$/.test(d)) return d;
  return null; // will use CURRENT_DATE in SQL
}

/* ─────────────────────────────────────────
   GET /dashboard/summary?date=YYYY-MM-DD
   ───────────────────────────────────────── */
exports.getDashboardSummary = async (req, res) => {
  try {
    const date = resolveDate(req);
    const dateExpr = date ? `$1::date` : `CURRENT_DATE`;
    const params   = date ? [date] : [];

    const sales = await DB.PostgresAny(`
      SELECT
        COUNT(*)                        AS total_bills,
        COALESCE(SUM(grand_total), 0)   AS total_sales,
        COALESCE(SUM(grand_total) FILTER (WHERE payment_mode = 'CASH'), 0) AS cash_total,
        COALESCE(SUM(grand_total) FILTER (WHERE payment_mode = 'UPI'),  0) AS upi_total
      FROM bills
      WHERE status = 'COMPLETED'
        AND DATE(created_at) = ${dateExpr}
    `, params);

    const pendingBills = await DB.PostgresAny(
      `SELECT COUNT(*) AS pending FROM bills WHERE status = 'PENDING'`
    );

    const products = await DB.PostgresAny(
      `SELECT COUNT(*) FROM products WHERE is_active = true`
    );
    const categories = await DB.PostgresAny(
      `SELECT COUNT(*) FROM categories WHERE status = true`
    );
    const employees = await DB.PostgresAny(
      `SELECT COUNT(*) FROM employees WHERE is_active = true`
    );

    const attendance = await DB.PostgresAny(`
      SELECT
        COUNT(*) FILTER (WHERE status = 'P') AS present,
        COUNT(*) FILTER (WHERE status = 'A') AS absent
      FROM attendance
      WHERE date = ${dateExpr}
    `, params);

    const stock = await DB.PostgresAny(`
      SELECT
        COUNT(*) AS total_items,
        COUNT(*) FILTER (WHERE current_qty <= min_qty AND current_qty > 0) AS low_stock,
        COUNT(*) FILTER (WHERE current_qty <= 0) AS out_of_stock
      FROM products
      WHERE track_stock = true AND is_active = true
    `);

    res.json({
      today_sales:   Number(sales[0].total_sales),
      today_bills:   Number(sales[0].total_bills),
      cash_total:    Number(sales[0].cash_total),
      upi_total:     Number(sales[0].upi_total),
      pending_bills: Number(pendingBills[0].pending),

      products:   Number(products[0].count),
      categories: Number(categories[0].count),
      employees:  Number(employees[0].count),

      attendance: {
        present: Number(attendance[0].present),
        absent:  Number(attendance[0].absent)
      },

      stock: {
        total_items:  Number(stock[0].total_items),
        low_stock:    Number(stock[0].low_stock),
        out_of_stock: Number(stock[0].out_of_stock)
      }
    });

  } catch (err) {
    console.error("Dashboard Error:", err);
    res.status(500).json({ message: "Dashboard load failed" });
  }
};

/* ─────────────────────────────────────────
   GET /dashboard/hourly_sales?date=YYYY-MM-DD
   ───────────────────────────────────────── */
exports.getHourlyItemSales = async (req, res) => {
  try {
    const date = resolveDate(req);
    const dateExpr = date ? `$1::date` : `CURRENT_DATE`;
    const params   = date ? [date] : [];

    const data = await DB.PostgresAny(`
      SELECT
        COALESCE(p.name, bi.product_name) AS item_name,
        TO_CHAR(DATE_TRUNC('hour', b.created_at), 'HH24:00')
          || ' - ' ||
          TO_CHAR(DATE_TRUNC('hour', b.created_at) + INTERVAL '1 hour', 'HH24:00')
          AS time_range,
        SUM(bi.qty)::INT AS total_count
      FROM bill_items bi
      JOIN bills b ON b.id = bi.bill_id
      LEFT JOIN products p ON p.id = bi.product_id
      WHERE b.status = 'COMPLETED'
        AND b.created_at::DATE = ${dateExpr}
      GROUP BY item_name, DATE_TRUNC('hour', b.created_at)
      ORDER BY DATE_TRUNC('hour', b.created_at)
    `, params);

    res.json(data);
  } catch (err) {
    console.error('Hourly sales failed:', err);
    res.status(500).json({ message: 'Hourly sales failed' });
  }
};

/* ─────────────────────────────────────────
   GET /dashboard/sales_chart?date=YYYY-MM-DD
   ───────────────────────────────────────── */
exports.getItemSalesChart = async (req, res) => {
  try {
    const date = resolveDate(req);
    const dateExpr = date ? `$1::date` : `CURRENT_DATE`;
    const params   = date ? [date] : [];

    const data = await DB.PostgresAny(`
      SELECT
        COALESCE(p.name, bi.product_name) AS item_name,
        SUM(bi.qty)                        AS total_count,
        SUM(bi.qty * bi.price)             AS total_revenue
      FROM bill_items bi
      JOIN bills b ON b.id = bi.bill_id
      LEFT JOIN products p ON p.id = bi.product_id
      WHERE b.status = 'COMPLETED'
        AND DATE(b.created_at) = ${dateExpr}
      GROUP BY item_name
      ORDER BY total_count DESC
    `, params);

    res.json(data);
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "Item chart failed" });
  }
};

/* ─────────────────────────────────────────
   GET /dashboard/daily_spend?date=YYYY-MM-DD
   Total daily spend + breakdown by reason
   ───────────────────────────────────────── */
exports.getDailySpend = async (req, res) => {
  try {
    const date = resolveDate(req);
    const dateExpr = date ? `$1::date` : `CURRENT_DATE`;
    const params   = date ? [date] : [];

    const total = await DB.PostgresAny(`
      SELECT COALESCE(SUM(amount), 0) AS total_spend
      FROM spent
      WHERE date::date = ${dateExpr}
    `, params);

    const breakdown = await DB.PostgresAny(`
      SELECT
        reason,
        COALESCE(SUM(amount), 0) AS total,
        COUNT(*)::INT             AS count
      FROM spent
      WHERE date::date = ${dateExpr}
      GROUP BY reason
      ORDER BY total DESC
    `, params);

    const records = await DB.PostgresAny(`
      SELECT id, reason, amount, TO_CHAR(created_at, 'HH12:MI AM') AS time
      FROM spent
      WHERE date::date = ${dateExpr}
      ORDER BY created_at DESC
    `, params);

    res.json({
      total_spend: Number(total[0].total_spend),
      breakdown,
      records
    });
  } catch (err) {
    console.error('Daily spend failed:', err);
    res.status(500).json({ message: 'Daily spend failed' });
  }
};

/* ─────────────────────────────────────────
   GET /dashboard/range_summary?start=YYYY-MM-DD&end=YYYY-MM-DD
   Sales + Expenses totals + daily breakdown for a date range
   ───────────────────────────────────────── */
exports.getRangeSummary = async (req, res) => {
  try {
    const s = req.query.start;
    const e = req.query.end;
    const dateRx = /^\d{4}-\d{2}-\d{2}$/;
    const start = (s && dateRx.test(s)) ? s : new Date(new Date().setDate(new Date().getDate() - 30)).toISOString().slice(0, 10);
    const end   = (e && dateRx.test(e)) ? e : new Date().toISOString().slice(0, 10);

    const sales = await DB.PostgresAny(`
      SELECT
        COALESCE(SUM(grand_total), 0)  AS total_sales,
        COUNT(*)::INT                  AS total_bills,
        COALESCE(SUM(grand_total) FILTER (WHERE payment_mode = 'CASH'), 0) AS cash_total,
        COALESCE(SUM(grand_total) FILTER (WHERE payment_mode = 'UPI'),  0) AS upi_total
      FROM bills
      WHERE status = 'COMPLETED'
        AND DATE(created_at) BETWEEN $1::date AND $2::date
    `, [start, end]);

    const spend = await DB.PostgresAny(`
      SELECT COALESCE(SUM(amount), 0) AS total_spend
      FROM spent
      WHERE date::date BETWEEN $1::date AND $2::date
    `, [start, end]);

    const dailySales = await DB.PostgresAny(`
      SELECT
        DATE(created_at)               AS day,
        COALESCE(SUM(grand_total), 0)  AS sales,
        COUNT(*)::INT                  AS bills
      FROM bills
      WHERE status = 'COMPLETED'
        AND DATE(created_at) BETWEEN $1::date AND $2::date
      GROUP BY DATE(created_at)
      ORDER BY day
    `, [start, end]);

    const dailySpend = await DB.PostgresAny(`
      SELECT
        date::date                    AS day,
        COALESCE(SUM(amount), 0)      AS spend
      FROM spent
      WHERE date::date BETWEEN $1::date AND $2::date
      GROUP BY date::date
      ORDER BY day
    `, [start, end]);

    const spendBreakdown = await DB.PostgresAny(`
      SELECT
        reason,
        COALESCE(SUM(amount), 0) AS total,
        COUNT(*)::INT             AS count
      FROM spent
      WHERE date::date BETWEEN $1::date AND $2::date
      GROUP BY reason
      ORDER BY total DESC
    `, [start, end]);

    res.json({
      start, end,
      total_sales:  Number(sales[0].total_sales),
      total_bills:  Number(sales[0].total_bills),
      cash_total:   Number(sales[0].cash_total),
      upi_total:    Number(sales[0].upi_total),
      total_spend:  Number(spend[0].total_spend),
      net_profit:   Number(sales[0].total_sales) - Number(spend[0].total_spend),
      daily_sales:  dailySales,
      daily_spend:  dailySpend,
      spend_breakdown: spendBreakdown
    });
  } catch (err) {
    console.error('Range summary failed:', err);
    res.status(500).json({ message: 'Range summary failed' });
  }
};

/* ─────────────────────────────────────────
   GET /dashboard/payment_breakdown?date=YYYY-MM-DD
   Cash vs UPI counts & amounts
   ───────────────────────────────────────── */
exports.getPaymentBreakdown = async (req, res) => {
  try {
    const date = resolveDate(req);
    const dateExpr = date ? `$1::date` : `CURRENT_DATE`;
    const params   = date ? [date] : [];

    const data = await DB.PostgresAny(`
      SELECT
        payment_mode,
        COUNT(*)                        AS bill_count,
        COALESCE(SUM(grand_total), 0)   AS total_amount
      FROM bills
      WHERE status = 'COMPLETED'
        AND DATE(created_at) = ${dateExpr}
      GROUP BY payment_mode
      ORDER BY payment_mode
    `, params);

    res.json(data);
  } catch (err) {
    console.error('Payment breakdown failed:', err);
    res.status(500).json({ message: 'Payment breakdown failed' });
  }
};

/* ─────────────────────────────────────────
   GET /dashboard/whatsapp-status
   Returns connection status + QR code (if not connected)
   ───────────────────────────────────────── */
exports.getWhatsappStatus = (req, res) => {
  const { qr, ready, error } = wa.getQR();
  res.json({ ready, qr: qr || null, error: error || null });
};

/* ─────────────────────────────────────────
   GET /dashboard/whatsapp-groups
   Returns list of WhatsApp groups (once connected)
   ───────────────────────────────────────── */
exports.getWhatsappGroups = async (req, res) => {
  try {
    const groups = await wa.getGroups();
    res.json(groups);
  } catch (err) {
    res.status(503).json({ message: err.message });
  }
};

/* ─────────────────────────────────────────
   POST /dashboard/whatsapp-send-now
   Admin: send daily summary immediately
   Body: { groupId: "..." }  — optional override
   ───────────────────────────────────────── */
exports.sendWhatsappNow = async (req, res) => {
  try {
    const groupId = req.body.groupId || process.env.WHATSAPP_GROUP_ID;
    if (!groupId) return res.status(400).json({ message: 'No group configured. Set WHATSAPP_GROUP_ID in .env or pass groupId in body.' });

    const message = await summary.buildWhatsAppMessage();
    await wa.sendToGroup(groupId, message);

    // Also save the configured groupId to env hint (not writing file, just in-memory for this run)
    if (req.body.groupId) process.env.WHATSAPP_GROUP_ID = req.body.groupId;

    res.json({ ok: true, message: 'Summary sent ✅' });
  } catch (err) {
    res.status(503).json({ message: err.message });
  }
};

/* ─────────────────────────────────────────
   GET /dashboard/whatsapp-preview
   Returns the formatted message text (no send)
   ───────────────────────────────────────── */
exports.previewWhatsapp = async (req, res) => {
  try {
    const message = await summary.buildWhatsAppMessage();
    res.json({ message });
  } catch (err) {
    res.status(500).json({ message: 'Failed to generate summary' });
  }
};
