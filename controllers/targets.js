const DB = require('../middleware/dbFunctions');

/* ──────────────────────────────────────────────
   CREATE TARGET
────────────────────────────────────────────── */
const createTarget = async (req, res) => {
  try {
    const { name = 'Monthly Target', start_date, end_date, room_rent_target = 0, eb_target = 0 } = req.body;
    if (!start_date || !end_date) {
      return res.status(400).json({ status: 'error', message: 'start_date and end_date are required' });
    }

    const rows = await DB.PostgresAny(
      `INSERT INTO targets (name, start_date, end_date, room_rent_target, eb_target)
       VALUES ($1, $2, $3, $4, $5) RETURNING *`,
      [name, start_date, end_date, room_rent_target, eb_target]
    );
    res.status(201).json(rows[0]);
  } catch (err) {
    console.error('createTarget error:', err);
    if (err.message && err.message.includes('does not exist')) {
      return res.status(500).json({
        status: 'error',
        message: 'Targets table not found. Please run the migration: migrations/targets.sql',
        detail: err.message
      });
    }
    res.status(500).json({ status: 'error', message: err.message });
  }
};

/* ──────────────────────────────────────────────
   GET ALL TARGETS
────────────────────────────────────────────── */
const getTargets = async (req, res) => {
  try {
    const rows = await DB.PostgresAny(
      `SELECT
         t.*,
         COALESCE(SUM(ti.target_amount), 0) AS total_items_target,
         COUNT(ti.id) AS item_count
       FROM targets t
       LEFT JOIN target_items ti ON ti.target_id = t.id
       GROUP BY t.id
       ORDER BY t.start_date DESC`
    );
    res.json(rows);
  } catch (err) {
    console.error('getTargets error:', err);
    if (err.message && err.message.includes('does not exist')) {
      return res.status(500).json({
        status: 'error',
        message: 'Targets table not found. Please run the migration: migrations/targets.sql',
        detail: err.message
      });
    }
    res.status(500).json({ status: 'error', message: err.message });
  }
};

/* ──────────────────────────────────────────────
   GET TARGET BY ID (with items)
────────────────────────────────────────────── */
const getTargetById = async (req, res) => {
  try {
    const { id } = req.params;

    const targets = await DB.PostgresAny(
      `SELECT * FROM targets WHERE id = $1`,
      [id]
    );
    if (!targets.length) {
      return res.status(404).json({ status: 'error', message: 'Target not found' });
    }

    const items = await DB.PostgresAny(
      `SELECT * FROM target_items WHERE target_id = $1 ORDER BY created_at ASC`,
      [id]
    );

    res.json({ ...targets[0], items });
  } catch (err) {
    console.error('getTargetById error:', err);
    res.status(500).json({ status: 'error', message: err.message });
  }
};

/* ──────────────────────────────────────────────
   UPDATE TARGET
────────────────────────────────────────────── */
const updateTarget = async (req, res) => {
  try {
    const { id } = req.params;
    const { name, start_date, end_date, room_rent_target, eb_target } = req.body;

    const rows = await DB.PostgresAny(
      `UPDATE targets
       SET name = COALESCE($1, name),
           start_date = COALESCE($2, start_date),
           end_date = COALESCE($3, end_date),
           room_rent_target = COALESCE($4, room_rent_target),
           eb_target = COALESCE($5, eb_target),
           updated_at = NOW()
       WHERE id = $6
       RETURNING *`,
      [name, start_date, end_date, room_rent_target, eb_target, id]
    );

    if (!rows.length) {
      return res.status(404).json({ status: 'error', message: 'Target not found' });
    }

    const items = await DB.PostgresAny(
      `SELECT * FROM target_items WHERE target_id = $1 ORDER BY created_at ASC`,
      [id]
    );

    res.json({ ...rows[0], items });
  } catch (err) {
    console.error('updateTarget error:', err);
    res.status(500).json({ status: 'error', message: err.message });
  }
};

/* ──────────────────────────────────────────────
   DELETE TARGET
────────────────────────────────────────────── */
const deleteTarget = async (req, res) => {
  try {
    const { id } = req.params;
    const rows = await DB.PostgresAny(
      `DELETE FROM targets WHERE id = $1 RETURNING id`,
      [id]
    );
    if (!rows.length) {
      return res.status(404).json({ status: 'error', message: 'Target not found' });
    }
    res.json({ status: 'success', message: 'Target deleted', id: rows[0].id });
  } catch (err) {
    console.error('deleteTarget error:', err);
    res.status(500).json({ status: 'error', message: err.message });
  }
};

/* ──────────────────────────────────────────────
   ADD TARGET ITEM
────────────────────────────────────────────── */
const addTargetItem = async (req, res) => {
  try {
    const { id } = req.params;
    const { item_name, target_amount } = req.body;

    if (!item_name || target_amount === undefined) {
      return res.status(400).json({ status: 'error', message: 'item_name and target_amount are required' });
    }

    const rows = await DB.PostgresAny(
      `INSERT INTO target_items (target_id, item_name, target_amount)
       VALUES ($1, $2, $3) RETURNING *`,
      [id, item_name, target_amount]
    );
    res.status(201).json(rows[0]);
  } catch (err) {
    console.error('addTargetItem error:', err);
    res.status(500).json({ status: 'error', message: err.message });
  }
};

/* ──────────────────────────────────────────────
   DELETE TARGET ITEM
────────────────────────────────────────────── */
const deleteTargetItem = async (req, res) => {
  try {
    const { id, itemId } = req.params;
    const rows = await DB.PostgresAny(
      `DELETE FROM target_items WHERE id = $1 AND target_id = $2 RETURNING id`,
      [itemId, id]
    );
    if (!rows.length) {
      return res.status(404).json({ status: 'error', message: 'Item not found' });
    }
    res.json({ status: 'success', message: 'Item deleted', id: rows[0].id });
  } catch (err) {
    console.error('deleteTargetItem error:', err);
    res.status(500).json({ status: 'error', message: err.message });
  }
};

/* ──────────────────────────────────────────────
   GET TARGET ACHIEVEMENT
────────────────────────────────────────────── */
const getTargetAchievement = async (req, res) => {
  try {
    const { id } = req.params;

    // Load target with items
    const targets = await DB.PostgresAny(
      `SELECT * FROM targets WHERE id = $1`,
      [id]
    );
    if (!targets.length) {
      return res.status(404).json({ status: 'error', message: 'Target not found' });
    }
    const target = targets[0];

    const items = await DB.PostgresAny(
      `SELECT * FROM target_items WHERE target_id = $1 ORDER BY created_at ASC`,
      [id]
    );
    target.items = items;

    const startDate = target.start_date;
    const endDate = target.end_date;

    // Actual total sales from bills
    const salesRows = await DB.PostgresAny(
      `SELECT COALESCE(SUM(grand_total),0) AS total_sales
       FROM bills
       WHERE status='COMPLETED' AND DATE(created_at) BETWEEN $1::date AND $2::date`,
      [startDate, endDate]
    );

    // Actual room rent from spent
    const roomRentRows = await DB.PostgresAny(
      `SELECT COALESCE(SUM(amount),0) AS actual
       FROM spent
       WHERE (LOWER(reason) LIKE '%room%rent%' OR LOWER(reason) LIKE '%rent%')
         AND date::date BETWEEN $1::date AND $2::date`,
      [startDate, endDate]
    );

    // Actual EB from spent
    const ebRows = await DB.PostgresAny(
      `SELECT COALESCE(SUM(amount),0) AS actual
       FROM spent
       WHERE (LOWER(reason) LIKE '%eb%' OR LOWER(reason) LIKE '%electricit%' OR LOWER(reason) LIKE '%current%')
         AND date::date BETWEEN $1::date AND $2::date`,
      [startDate, endDate]
    );

    // Bill count
    const billCountRows = await DB.PostgresAny(
      `SELECT COUNT(*) AS total_bills
       FROM bills
       WHERE status='COMPLETED' AND DATE(created_at) BETWEEN $1::date AND $2::date`,
      [startDate, endDate]
    );

    // Total expenses (all spent records in range)
    const expensesRows = await DB.PostgresAny(
      `SELECT COALESCE(SUM(amount),0) AS total_spent
       FROM spent
       WHERE date::date BETWEEN $1::date AND $2::date`,
      [startDate, endDate]
    );

    const actual_sales = parseFloat(salesRows[0]?.total_sales || 0);
    const actual_room_rent = parseFloat(roomRentRows[0]?.actual || 0);
    const actual_eb = parseFloat(ebRows[0]?.actual || 0);
    const actual_bills = parseInt(billCountRows[0]?.total_bills || 0, 10);
    const total_expenses = parseFloat(expensesRows[0]?.total_spent || 0);
    const net_profit = actual_sales - total_expenses;

    const total_sales_target = items.reduce((sum, item) => sum + parseFloat(item.target_amount || 0), 0);

    // Days elapsed
    const now = new Date();
    const start = new Date(startDate);
    const end = new Date(endDate);
    const total_days = Math.max(1, Math.round((end - start) / (1000 * 60 * 60 * 24)) + 1);
    const elapsed = Math.max(0, Math.min(total_days, Math.round((now - start) / (1000 * 60 * 60 * 24)) + 1));

    res.json({
      target,
      actual_sales,
      actual_bills,
      actual_room_rent,
      actual_eb,
      total_expenses,
      net_profit,
      total_sales_target,
      days_elapsed: elapsed,
      total_days
    });
  } catch (err) {
    console.error('getTargetAchievement error:', err);
    res.status(500).json({ status: 'error', message: err.message });
  }
};

module.exports = {
  createTarget,
  getTargets,
  getTargetById,
  updateTarget,
  deleteTarget,
  addTargetItem,
  deleteTargetItem,
  getTargetAchievement
};
