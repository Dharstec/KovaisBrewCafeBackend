const DB = require('../middleware/dbFunctions');

const createTarget = async (req, res) => {
  try {
    const { name = 'Monthly Target', start_date, end_date, sales_target = 0 } = req.body;
    if (!start_date || !end_date)
      return res.status(400).json({ message: 'start_date and end_date are required' });

    const rows = await DB.PostgresAny(
      `INSERT INTO targets (name, start_date, end_date, sales_target, shop_id)
       VALUES ($1,$2,$3,$4,$5) RETURNING *`,
      [name, start_date, end_date, sales_target, req.shop_id]
    );
    res.status(201).json(rows[0]);
  } catch (err) {
    console.error('createTarget:', err.message);
    res.status(500).json({ message: err.message });
  }
};

const getTargets = async (req, res) => {
  try {
    const rows = await DB.PostgresAny(`
      SELECT
        t.*,
        COALESCE(SUM(ti.target_amount), 0) AS total_budget,
        COUNT(ti.id)::INT                  AS item_count
      FROM targets t
      LEFT JOIN target_items ti ON ti.target_id = t.id
      WHERE t.shop_id = $1
      GROUP BY t.id
      ORDER BY t.start_date DESC
    `, [req.shop_id]);
    res.json(rows);
  } catch (err) {
    console.error('getTargets:', err.message);
    res.status(500).json({ message: err.message });
  }
};

const getTargetById = async (req, res) => {
  try {
    const { id } = req.params;
    const targets = await DB.PostgresAny(
      `SELECT * FROM targets WHERE id = $1 AND shop_id = $2`,
      [id, req.shop_id]
    );
    if (!targets.length) return res.status(404).json({ message: 'Target not found' });

    const items = await DB.PostgresAny(
      `SELECT * FROM target_items WHERE target_id = $1 ORDER BY created_at ASC`, [id]
    );
    res.json({ ...targets[0], items });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};

const updateTarget = async (req, res) => {
  try {
    const { id } = req.params;
    const { name, start_date, end_date, sales_target } = req.body;

    const rows = await DB.PostgresAny(`
      UPDATE targets
      SET name         = COALESCE($1, name),
          start_date   = COALESCE($2, start_date),
          end_date     = COALESCE($3, end_date),
          sales_target = COALESCE($4, sales_target),
          updated_at   = NOW()
      WHERE id = $5 AND shop_id = $6 RETURNING *
    `, [name, start_date, end_date, sales_target, id, req.shop_id]);

    if (!rows.length) return res.status(404).json({ message: 'Target not found' });

    const items = await DB.PostgresAny(
      `SELECT * FROM target_items WHERE target_id = $1 ORDER BY created_at ASC`, [id]
    );
    res.json({ ...rows[0], items });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};

const deleteTarget = async (req, res) => {
  try {
    const { id } = req.params;
    const rows = await DB.PostgresAny(
      `DELETE FROM targets WHERE id = $1 AND shop_id = $2 RETURNING id`,
      [id, req.shop_id]
    );
    if (!rows.length) return res.status(404).json({ message: 'Target not found' });
    res.json({ ok: true, id: rows[0].id });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};

const addTargetItem = async (req, res) => {
  try {
    const { id } = req.params;
    const { item_name, target_amount } = req.body;

    if (!item_name || target_amount === undefined)
      return res.status(400).json({ message: 'item_name and target_amount are required' });

    const owns = await DB.PostgresAny(
      `SELECT id FROM targets WHERE id = $1 AND shop_id = $2`,
      [id, req.shop_id]
    );
    if (!owns.length) return res.status(404).json({ message: 'Target not found' });

    const rows = await DB.PostgresAny(
      `INSERT INTO target_items (target_id, item_name, target_amount)
       VALUES ($1,$2,$3) RETURNING *`,
      [id, item_name, target_amount]
    );
    res.status(201).json(rows[0]);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};

const deleteTargetItem = async (req, res) => {
  try {
    const { id, itemId } = req.params;
    const owns = await DB.PostgresAny(
      `SELECT id FROM targets WHERE id = $1 AND shop_id = $2`,
      [id, req.shop_id]
    );
    if (!owns.length) return res.status(404).json({ message: 'Target not found' });

    const rows = await DB.PostgresAny(
      `DELETE FROM target_items WHERE id = $1 AND target_id = $2 RETURNING id`,
      [itemId, id]
    );
    if (!rows.length) return res.status(404).json({ message: 'Item not found' });
    res.json({ ok: true, id: rows[0].id });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};

const getTargetAchievement = async (req, res) => {
  try {
    const { id } = req.params;
    const shopId = req.shop_id;

    const targets = await DB.PostgresAny(
      `SELECT * FROM targets WHERE id = $1 AND shop_id = $2`,
      [id, shopId]
    );
    if (!targets.length) return res.status(404).json({ message: 'Target not found' });
    const target = targets[0];

    const items = await DB.PostgresAny(
      `SELECT * FROM target_items WHERE target_id = $1 ORDER BY created_at ASC`, [id]
    );
    target.items = items;

    const { start_date, end_date, sales_target } = target;

    const salesRow = await DB.PostgresAny(`
      SELECT
        COALESCE(SUM(grand_total), 0) AS total_sales,
        COALESCE(SUM(grand_total) FILTER (WHERE payment_mode = 'CASH'), 0) AS cash_sales,
        COALESCE(SUM(grand_total) FILTER (WHERE payment_mode = 'UPI'),  0) AS upi_sales,
        COUNT(*)::INT AS total_bills
      FROM bills
      WHERE status = 'COMPLETED'
        AND DATE(created_at) BETWEEN $1::date AND $2::date
        AND shop_id = $3
    `, [start_date, end_date, shopId]);

    const spentRow = await DB.PostgresAny(`
      SELECT COALESCE(SUM(amount), 0) AS total_spent
      FROM spent
      WHERE date::date BETWEEN $1::date AND $2::date AND shop_id = $3
    `, [start_date, end_date, shopId]);

    const advanceRow = await DB.PostgresAny(`
      SELECT
        COALESCE(SUM(ea.amount), 0) AS total_advance,
        JSON_AGG(
          JSON_BUILD_OBJECT(
            'employee_name', e.name,
            'amount',        ea.amount,
            'advance_date',  ea.advance_date,
            'note',          ea.note
          ) ORDER BY ea.advance_date DESC
        ) FILTER (WHERE ea.id IS NOT NULL) AS advance_list
      FROM employee_advance ea
      JOIN employees e ON e.id = ea.employee_id
      WHERE ea.advance_date::date BETWEEN $1::date AND $2::date
        AND ea.shop_id = $3
    `, [start_date, end_date, shopId]);

    const itemActuals = {};
    const itemBreakdown = {};

    for (const item of items) {
      const kw = `%${item.item_name.toLowerCase()}%`;

      const spentMatch = await DB.PostgresAny(`
        SELECT COALESCE(SUM(amount), 0) AS actual
        FROM spent
        WHERE LOWER(reason) LIKE $1
          AND date::date BETWEEN $2::date AND $3::date
          AND shop_id = $4
      `, [kw, start_date, end_date, shopId]);

      const advanceMatch = await DB.PostgresAny(`
        SELECT COALESCE(SUM(ea.amount), 0) AS actual
        FROM employee_advance ea
        JOIN employees e ON e.id = ea.employee_id
        WHERE LOWER(e.name) LIKE $1
          AND ea.advance_date::date BETWEEN $2::date AND $3::date
          AND ea.shop_id = $4
      `, [kw, start_date, end_date, shopId]);

      const fromSpent   = parseFloat(spentMatch[0]?.actual   || 0);
      const fromAdvance = parseFloat(advanceMatch[0]?.actual || 0);

      itemActuals[item.id] = fromSpent + fromAdvance;
      itemBreakdown[item.id] = { fromSpent, fromAdvance };
    }

    const now        = new Date();
    const start      = new Date(start_date);
    const end        = new Date(end_date);
    const total_days   = Math.max(1, Math.round((end - start) / 86400000) + 1);
    const days_elapsed = Math.max(1, Math.min(total_days, Math.round((now - start) / 86400000) + 1));
    const days_left    = Math.max(0, total_days - days_elapsed);

    const actual_sales    = parseFloat(salesRow[0].total_sales);
    const cash_sales      = parseFloat(salesRow[0].cash_sales);
    const upi_sales       = parseFloat(salesRow[0].upi_sales);
    const total_bills     = salesRow[0].total_bills;
    const spent_expenses  = parseFloat(spentRow[0].total_spent);
    const employee_advance_total = parseFloat(advanceRow[0]?.total_advance || 0);
    const advance_list    = advanceRow[0]?.advance_list || [];

    const total_expenses  = spent_expenses + employee_advance_total;
    const in_hand         = actual_sales - total_expenses;
    const net_profit      = in_hand;

    const avg_daily_sales    = days_elapsed > 0 ? actual_sales / days_elapsed : 0;
    const projected_sales    = avg_daily_sales * total_days;
    const remaining_sales    = Math.max(0, parseFloat(sales_target || 0) - actual_sales);
    const daily_sales_needed = days_left > 0 ? remaining_sales / days_left : 0;

    const total_budget       = items.reduce((s, i) => s + parseFloat(i.target_amount || 0), 0);
    const avg_daily_expense  = days_elapsed > 0 ? total_expenses / days_elapsed : 0;
    const total_item_paid    = Object.values(itemActuals).reduce((s, v) => s + v, 0);
    const budget_remaining   = Math.max(0, total_budget - total_item_paid);
    const projected_future_daily_exp = avg_daily_expense * days_left;
    const net_still_needed   = Math.max(0, budget_remaining + projected_future_daily_exp - in_hand);
    const budget_daily_needed = days_left > 0 ? Math.ceil(net_still_needed / days_left) : 0;
    const budget_on_track     = avg_daily_sales >= budget_daily_needed;

    res.json({
      target,
      actual_sales, cash_sales, upi_sales, total_bills,
      sales_target: parseFloat(sales_target || 0),
      remaining_sales, avg_daily_sales, projected_sales, daily_sales_needed,
      spent_expenses, employee_advance_total, advance_list,
      total_expenses, total_budget, avg_daily_expense,
      total_item_paid, budget_remaining, projected_future_daily_exp,
      net_still_needed, budget_daily_needed, budget_on_track,
      in_hand, net_profit,
      days_elapsed, days_left, total_days,
      item_actuals: itemActuals,
      item_breakdown: itemBreakdown
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
