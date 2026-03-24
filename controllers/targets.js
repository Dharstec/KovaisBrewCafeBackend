const DB = require('../middleware/dbFunctions');

/* ──────────────────────────────────────────────
   CREATE TARGET
────────────────────────────────────────────── */
const createTarget = async (req, res) => {
  try {
    const { name = 'Monthly Target', start_date, end_date } = req.body;
    if (!start_date || !end_date)
      return res.status(400).json({ message: 'start_date and end_date are required' });

    const rows = await DB.PostgresAny(
      `INSERT INTO targets (name, start_date, end_date) VALUES ($1,$2,$3) RETURNING *`,
      [name, start_date, end_date]
    );
    res.status(201).json(rows[0]);
  } catch (err) {
    console.error('createTarget:', err.message);
    if (err.message.includes('does not exist'))
      return res.status(500).json({ message: 'Run migration: migrations/targets.sql' });
    res.status(500).json({ message: err.message });
  }
};

/* ──────────────────────────────────────────────
   GET ALL TARGETS
────────────────────────────────────────────── */
const getTargets = async (req, res) => {
  try {
    const rows = await DB.PostgresAny(`
      SELECT
        t.*,
        COALESCE(SUM(ti.target_amount), 0) AS total_budget,
        COUNT(ti.id)::INT                  AS item_count
      FROM targets t
      LEFT JOIN target_items ti ON ti.target_id = t.id
      GROUP BY t.id
      ORDER BY t.start_date DESC
    `);
    res.json(rows);
  } catch (err) {
    console.error('getTargets:', err.message);
    if (err.message.includes('does not exist'))
      return res.status(500).json({ message: 'Run migration: migrations/targets.sql' });
    res.status(500).json({ message: err.message });
  }
};

/* ──────────────────────────────────────────────
   GET TARGET BY ID (with expense items)
────────────────────────────────────────────── */
const getTargetById = async (req, res) => {
  try {
    const { id } = req.params;
    const targets = await DB.PostgresAny(`SELECT * FROM targets WHERE id = $1`, [id]);
    if (!targets.length) return res.status(404).json({ message: 'Target not found' });

    const items = await DB.PostgresAny(
      `SELECT * FROM target_items WHERE target_id = $1 ORDER BY created_at ASC`, [id]
    );
    res.json({ ...targets[0], items });
  } catch (err) {
    console.error('getTargetById:', err.message);
    res.status(500).json({ message: err.message });
  }
};

/* ──────────────────────────────────────────────
   UPDATE TARGET
────────────────────────────────────────────── */
const updateTarget = async (req, res) => {
  try {
    const { id } = req.params;
    const { name, start_date, end_date } = req.body;

    const rows = await DB.PostgresAny(`
      UPDATE targets
      SET name       = COALESCE($1, name),
          start_date = COALESCE($2, start_date),
          end_date   = COALESCE($3, end_date),
          updated_at = NOW()
      WHERE id = $4 RETURNING *
    `, [name, start_date, end_date, id]);

    if (!rows.length) return res.status(404).json({ message: 'Target not found' });

    const items = await DB.PostgresAny(
      `SELECT * FROM target_items WHERE target_id = $1 ORDER BY created_at ASC`, [id]
    );
    res.json({ ...rows[0], items });
  } catch (err) {
    console.error('updateTarget:', err.message);
    res.status(500).json({ message: err.message });
  }
};

/* ──────────────────────────────────────────────
   DELETE TARGET
────────────────────────────────────────────── */
const deleteTarget = async (req, res) => {
  try {
    const { id } = req.params;
    const rows = await DB.PostgresAny(`DELETE FROM targets WHERE id = $1 RETURNING id`, [id]);
    if (!rows.length) return res.status(404).json({ message: 'Target not found' });
    res.json({ ok: true, id: rows[0].id });
  } catch (err) {
    console.error('deleteTarget:', err.message);
    res.status(500).json({ message: err.message });
  }
};

/* ──────────────────────────────────────────────
   ADD EXPENSE ITEM
────────────────────────────────────────────── */
const addTargetItem = async (req, res) => {
  try {
    const { id } = req.params;
    const { item_name, target_amount } = req.body;

    if (!item_name || target_amount === undefined)
      return res.status(400).json({ message: 'item_name and target_amount are required' });

    const rows = await DB.PostgresAny(
      `INSERT INTO target_items (target_id, item_name, target_amount)
       VALUES ($1,$2,$3) RETURNING *`,
      [id, item_name, target_amount]
    );
    res.status(201).json(rows[0]);
  } catch (err) {
    console.error('addTargetItem:', err.message);
    res.status(500).json({ message: err.message });
  }
};

/* ──────────────────────────────────────────────
   DELETE EXPENSE ITEM
────────────────────────────────────────────── */
const deleteTargetItem = async (req, res) => {
  try {
    const { id, itemId } = req.params;
    const rows = await DB.PostgresAny(
      `DELETE FROM target_items WHERE id = $1 AND target_id = $2 RETURNING id`,
      [itemId, id]
    );
    if (!rows.length) return res.status(404).json({ message: 'Item not found' });
    res.json({ ok: true, id: rows[0].id });
  } catch (err) {
    console.error('deleteTargetItem:', err.message);
    res.status(500).json({ message: err.message });
  }
};

/* ──────────────────────────────────────────────
   GET TARGET ACHIEVEMENT
   Returns:
   - actual sales (from bills) for the date range
   - actual spent per expense item (from spent, matched by reason keyword)
   - daily average, projected totals, net profit
────────────────────────────────────────────── */
const getTargetAchievement = async (req, res) => {
  try {
    const { id } = req.params;

    const targets = await DB.PostgresAny(`SELECT * FROM targets WHERE id = $1`, [id]);
    if (!targets.length) return res.status(404).json({ message: 'Target not found' });
    const target = targets[0];

    const items = await DB.PostgresAny(
      `SELECT * FROM target_items WHERE target_id = $1 ORDER BY created_at ASC`, [id]
    );
    target.items = items;

    const { start_date, end_date } = target;

    // ── Actual sales from bills ──
    const salesRow = await DB.PostgresAny(`
      SELECT
        COALESCE(SUM(grand_total), 0)                                              AS total_sales,
        COALESCE(SUM(grand_total) FILTER (WHERE payment_mode = 'CASH'),  0)       AS cash_sales,
        COALESCE(SUM(grand_total) FILTER (WHERE payment_mode = 'UPI'),   0)       AS upi_sales,
        COUNT(*)::INT                                                               AS total_bills
      FROM bills
      WHERE status = 'COMPLETED'
        AND DATE(created_at) BETWEEN $1::date AND $2::date
    `, [start_date, end_date]);

    // ── Total actual expenses (all spent in range) ──
    const spentRow = await DB.PostgresAny(`
      SELECT COALESCE(SUM(amount), 0) AS total_spent
      FROM spent
      WHERE date::date BETWEEN $1::date AND $2::date
    `, [start_date, end_date]);

    // ── Per item: match actual from spent by reason keyword ──
    const itemActuals = {};
    for (const item of items) {
      const kw = `%${item.item_name.toLowerCase()}%`;
      const r = await DB.PostgresAny(`
        SELECT COALESCE(SUM(amount), 0) AS actual
        FROM spent
        WHERE LOWER(reason) LIKE $1
          AND date::date BETWEEN $2::date AND $3::date
      `, [kw, start_date, end_date]);
      itemActuals[item.id] = parseFloat(r[0]?.actual || 0);
    }

    // ── Days calculation ──
    const now       = new Date();
    const start     = new Date(start_date);
    const end       = new Date(end_date);
    const total_days   = Math.max(1, Math.round((end - start) / 86400000) + 1);
    const days_elapsed = Math.max(1, Math.min(total_days, Math.round((now - start) / 86400000) + 1));
    const days_left    = Math.max(0, total_days - days_elapsed);

    const actual_sales   = parseFloat(salesRow[0].total_sales);
    const cash_sales     = parseFloat(salesRow[0].cash_sales);
    const upi_sales      = parseFloat(salesRow[0].upi_sales);
    const total_bills    = salesRow[0].total_bills;
    const total_spent    = parseFloat(spentRow[0].total_spent);
    const net_profit     = actual_sales - total_spent;

    const avg_daily_sales   = days_elapsed > 0 ? actual_sales / days_elapsed : 0;
    const projected_sales   = avg_daily_sales * total_days;
    const avg_daily_expense = days_elapsed > 0 ? total_spent / days_elapsed : 0;

    const total_budget = items.reduce((s, i) => s + parseFloat(i.target_amount || 0), 0);

    res.json({
      target,
      actual_sales,
      cash_sales,
      upi_sales,
      total_bills,
      total_spent,
      net_profit,
      total_budget,
      avg_daily_sales,
      projected_sales,
      avg_daily_expense,
      days_elapsed,
      days_left,
      total_days,
      item_actuals: itemActuals
    });
  } catch (err) {
    console.error('getTargetAchievement:', err.message);
    res.status(500).json({ message: err.message });
  }
};

module.exports = {
  createTarget, getTargets, getTargetById, updateTarget, deleteTarget,
  addTargetItem, deleteTargetItem, getTargetAchievement
};
