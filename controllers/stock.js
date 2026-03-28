const DB = require("../middleware/dbFunctions");

/* =========================================================
   STOCK PAGE — all quantity operations

   Tables used:
     stock_items    — master list of raw materials
     stock_entries  — every purchase (qty, price, expiry)
     stock_logs     — every movement (in / out / adjust)
   ========================================================= */


/* ─────────────────────────────────────────────────────────
   CURRENT STOCK LEVELS
   Used by: Stock page main view
   ───────────────────────────────────────────────────────── */
exports.getStock = async (_req, res) => {
  try {
    const data = await DB.PostgresAny(`
      SELECT
        si.id,
        si.name,
        c.name                              AS category_name,
        si.base_unit,
        si.unit_label,
        si.unit_value,
        ROUND(si.current_qty, 2)            AS current_qty,
        ROUND(si.min_qty, 2)                AS min_qty,
        si.current_qty <= si.min_qty        AS is_low_stock,

        -- nearest expiry among active entries
        (SELECT MIN(se.expiry_date)
           FROM stock_entries se
          WHERE se.stock_item_id = si.id
            AND se.remaining_qty > 0
            AND se.expiry_date IS NOT NULL
        )                                   AS nearest_expiry,

        -- how many entries expiring within 7 days
        (SELECT COUNT(*)
           FROM stock_entries se
          WHERE se.stock_item_id = si.id
            AND se.remaining_qty > 0
            AND se.expiry_date IS NOT NULL
            AND se.expiry_date <= CURRENT_DATE + INTERVAL '7 days'
        )                                   AS expiring_entry_count,

        -- any already-expired entry still has stock?
        EXISTS (
          SELECT 1 FROM stock_entries se
          WHERE se.stock_item_id = si.id
            AND se.remaining_qty > 0
            AND se.expiry_date IS NOT NULL
            AND se.expiry_date < CURRENT_DATE
        )                                   AS has_expired_stock,

        -- last purchase price and date for quick reference
        (SELECT se.purchase_price
           FROM stock_entries se
          WHERE se.stock_item_id = si.id
          ORDER BY se.purchase_date DESC, se.created_at DESC
          LIMIT 1
        )                                   AS last_purchase_price,

        (SELECT se.purchase_date
           FROM stock_entries se
          WHERE se.stock_item_id = si.id
          ORDER BY se.purchase_date DESC, se.created_at DESC
          LIMIT 1
        )                                   AS last_purchase_date

      FROM stock_items si
      LEFT JOIN categories c ON c.id = si.category_id
      WHERE si.is_active = true
      ORDER BY si.current_qty <= si.min_qty DESC, si.name ASC
    `, []);

    res.json(data);
  } catch (err) {
    console.error("Get stock error:", err);
    res.status(500).json({ message: "Failed to get stock" });
  }
};


/* ─────────────────────────────────────────────────────────
   STOCK ITEMS DROPDOWN  (for recipe builder)
   ───────────────────────────────────────────────────────── */
exports.getDropDownStock = async (_req, res) => {
  try {
    const data = await DB.PostgresAny(`
      SELECT id, name, base_unit, unit_label, unit_value,
             ROUND(current_qty, 2) AS current_qty
      FROM stock_items
      WHERE is_active = true
      ORDER BY name
    `, []);
    res.json(data);
  } catch (err) {
    console.error("Get dropdown error:", err);
    res.status(500).json({ message: "Failed" });
  }
};


/* ─────────────────────────────────────────────────────────
   ADD STOCK ENTRY  — every purchase is one entry

   Body:
     stock_item_id  : which item
     qty            : how many (in unit_label, e.g. 5 for "5 kg")
     purchase_price : price per unit_label  (e.g. ₹45 per kg)
     purchase_date  : when bought  (YYYY-MM-DD)
     expiry_date    : expiry        (YYYY-MM-DD)  optional
     supplier       : vendor name   optional
     batch_no       : lot / batch   optional
     notes          : any note      optional

   Auto-converts qty → base_qty using item's unit_value
   e.g. 5 kg × 1000 = 5000 gm stored
   ───────────────────────────────────────────────────────── */
exports.addStockEntry = async (req, res) => {
  const client = await DB.getClient();
  try {
    const {
      stock_item_id,
      qty,
      purchase_price,
      purchase_date,
      expiry_date,
      supplier,
      batch_no,
      notes
    } = req.body;

    if (!stock_item_id || !qty || !purchase_price) {
      return res.status(400).json({
        message: "stock_item_id, qty, purchase_price are required"
      });
    }

    // Get item info for unit conversion
    const item = await DB.PostgresAny(
      `SELECT id, name, base_unit, unit_label, unit_value
       FROM stock_items WHERE id = $1 AND is_active = true`,
      [stock_item_id]
    );
    if (!item.length) {
      return res.status(404).json({ message: "Stock item not found" });
    }

    const { unit_value, unit_label, base_unit, name } = item[0];
    // base_qty = qty × unit_value
    // Example: 5 kg × 1000 = 5000 gm
    const base_qty = Number(qty) * Number(unit_value);

    await client.query("BEGIN");

    // 1. Save entry
    const entryRes = await client.query(`
      INSERT INTO stock_entries
        (stock_item_id, qty, unit, base_qty, remaining_qty,
         purchase_price, purchase_date, expiry_date,
         supplier, batch_no, notes)
      VALUES ($1,$2,$3,$4,$4,$5,$6,$7,$8,$9,$10)
      RETURNING id
    `, [
      stock_item_id,
      Number(qty),
      unit_label,
      base_qty,
      Number(purchase_price),
      purchase_date  || new Date().toISOString().split('T')[0],
      expiry_date    || null,
      supplier       || null,
      batch_no       || null,
      notes          || null
    ]);

    // 2. Update live stock level
    await client.query(`
      UPDATE stock_items
      SET current_qty = current_qty + $1,
          updated_at  = NOW()
      WHERE id = $2
    `, [base_qty, stock_item_id]);

    // 3. Write to stock_logs
    const logParts = [
      `Added ${qty} ${unit_label}`,
      supplier    ? `from ${supplier}`   : null,
      expiry_date ? `expires ${expiry_date}` : null,
      `@ ₹${purchase_price}/${unit_label}`
    ].filter(Boolean).join(' | ');

    await client.query(`
      INSERT INTO stock_logs
        (stock_item_id, stock_entry_id, change_qty, action, note)
      VALUES ($1, $2, $3, 'STOCK_IN', $4)
    `, [stock_item_id, entryRes.rows[0].id, base_qty, logParts]);

    await client.query("COMMIT");

    res.status(201).json({
      message:      "Stock added",
      entry_id:     entryRes.rows[0].id,
      item:         name,
      qty_added:    qty,
      unit:         unit_label,
      base_qty:     base_qty,
      base_unit:    base_unit,
      new_total:    (await DB.PostgresAny(`SELECT current_qty FROM stock_items WHERE id=$1`, [stock_item_id]))[0].current_qty
    });

  } catch (err) {
    await client.query("ROLLBACK");
    console.error("Add stock entry error:", err);
    res.status(500).json({ message: "Failed to add stock", error: err.message });
  } finally {
    client.release();
  }
};


/* ─────────────────────────────────────────────────────────
   STOCK ENTRIES LIST  — purchase history

   ?stock_item_id=X  filter by item
   ?page=1&limit=20

   Returns every purchase with price so you can track
   if the price has gone up or down over time
   ───────────────────────────────────────────────────────── */
exports.getStockEntries = async (req, res) => {
  try {
    const { stock_item_id, page = 1, limit = 20 } = req.query;

    const pageNo   = Number(page);
    const pageSize = Number(limit);
    const offset   = (pageNo - 1) * pageSize;

    const params = [];
    let where = '';
    if (stock_item_id) {
      params.push(stock_item_id);
      where = `WHERE se.stock_item_id = $${params.length}`;
    }

    const entries = await DB.PostgresAny(`
      SELECT
        se.id,
        se.stock_item_id,
        si.name                           AS item_name,
        si.base_unit,
        se.qty,
        se.unit,
        se.base_qty,
        ROUND(se.remaining_qty, 2)        AS remaining_qty,
        se.purchase_price,
        se.purchase_date,
        se.expiry_date,
        se.supplier,
        se.batch_no,
        se.notes,
        se.created_at,

        -- days until expiry
        (se.expiry_date - CURRENT_DATE)   AS days_to_expiry,

        -- expiry status for colour-coding on frontend
        CASE
          WHEN se.expiry_date IS NULL                                        THEN 'NO_EXPIRY'
          WHEN se.expiry_date < CURRENT_DATE                                 THEN 'EXPIRED'
          WHEN se.expiry_date <= CURRENT_DATE + INTERVAL '3 days'            THEN 'EXPIRING_TODAY'
          WHEN se.expiry_date <= CURRENT_DATE + INTERVAL '7 days'            THEN 'EXPIRING_SOON'
          ELSE                                                                    'OK'
        END                               AS expiry_status,

        -- fully consumed?
        se.remaining_qty <= 0             AS is_consumed

      FROM stock_entries se
      JOIN stock_items si ON si.id = se.stock_item_id
      ${where}
      ORDER BY se.purchase_date DESC, se.created_at DESC
      LIMIT $${params.length + 1} OFFSET $${params.length + 2}
    `, [...params, pageSize, offset]);

    const count = await DB.PostgresAny(
      `SELECT COUNT(*) AS total FROM stock_entries se ${where}`,
      params
    );

    res.json({
      data:       entries,
      total:      Number(count[0].total),
      page:       pageNo,
      limit:      pageSize,
      totalPages: Math.ceil(Number(count[0].total) / pageSize)
    });

  } catch (err) {
    console.error("Get stock entries error:", err);
    res.status(500).json({ message: "Failed to get stock entries" });
  }
};


/* ─────────────────────────────────────────────────────────
   PRICE HISTORY  — for one item, see how price changed
   GET /stock/price-history/:stock_item_id
   ───────────────────────────────────────────────────────── */
exports.getPriceHistory = async (req, res) => {
  try {
    const { stock_item_id } = req.params;

    const data = await DB.PostgresAny(`
      SELECT
        se.id,
        se.purchase_date,
        se.qty,
        se.unit,
        se.purchase_price,
        se.supplier,
        se.batch_no,
        si.name AS item_name,
        si.unit_label
      FROM stock_entries se
      JOIN stock_items si ON si.id = se.stock_item_id
      WHERE se.stock_item_id = $1
      ORDER BY se.purchase_date DESC, se.created_at DESC
    `, [stock_item_id]);

    res.json(data);
  } catch (err) {
    console.error("Price history error:", err);
    res.status(500).json({ message: "Failed to get price history" });
  }
};


/* ─────────────────────────────────────────────────────────
   EXPIRY ALERTS  — entries expiring within N days
   GET /stock/expiring?days=7
   ───────────────────────────────────────────────────────── */
exports.getExpiringEntries = async (req, res) => {
  try {
    const days = Number(req.query.days) || 7;

    const data = await DB.PostgresAny(`
      SELECT
        se.id,
        si.name             AS item_name,
        si.base_unit,
        se.qty,
        se.unit,
        se.remaining_qty,
        se.purchase_price,
        se.purchase_date,
        se.expiry_date,
        se.supplier,
        se.batch_no,
        (se.expiry_date - CURRENT_DATE) AS days_to_expiry,
        CASE
          WHEN se.expiry_date < CURRENT_DATE                      THEN 'EXPIRED'
          WHEN se.expiry_date <= CURRENT_DATE + INTERVAL '3 days' THEN 'EXPIRING_TODAY'
          ELSE                                                          'EXPIRING_SOON'
        END AS status
      FROM stock_entries se
      JOIN stock_items si ON si.id = se.stock_item_id
      WHERE se.remaining_qty > 0
        AND se.expiry_date IS NOT NULL
        AND se.expiry_date <= CURRENT_DATE + ($1 || ' days')::INTERVAL
      ORDER BY se.expiry_date ASC
    `, [days]);

    res.json(data);
  } catch (err) {
    console.error("Get expiring error:", err);
    res.status(500).json({ message: "Failed to get expiring entries" });
  }
};


/* ─────────────────────────────────────────────────────────
   MANUAL ADJUSTMENT  — wastage / correction
   change_qty: positive = add more, negative = remove
   ───────────────────────────────────────────────────────── */
exports.adjustStock = async (req, res) => {
  const client = await DB.getClient();
  try {
    const { stock_item_id, change_qty, reason, note } = req.body;

    if (!stock_item_id || change_qty == null) {
      return res.status(400).json({ message: "stock_item_id and change_qty required" });
    }

    const validReasons = ['DAILY_REFILL', 'WASTAGE', 'ADJUSTMENT'];
    const logReason    = validReasons.includes(reason) ? reason : 'ADJUSTMENT';

    await client.query("BEGIN");

    const result = await client.query(`
      UPDATE stock_items
      SET current_qty = current_qty + $1,
          updated_at  = NOW()
      WHERE id = $2 AND is_active = true
      RETURNING current_qty, name
    `, [change_qty, stock_item_id]);

    if (!result.rows.length) {
      await client.query("ROLLBACK");
      return res.status(404).json({ message: "Stock item not found" });
    }

    await client.query(`
      INSERT INTO stock_logs
        (stock_item_id, change_qty, action, reason, note)
      VALUES ($1, $2, 'ADJUSTMENT', $3, $4)
    `, [stock_item_id, change_qty, logReason, note || null]);

    await client.query("COMMIT");

    res.json({
      message:     "Stock adjusted",
      item:        result.rows[0].name,
      current_qty: result.rows[0].current_qty
    });

  } catch (err) {
    await client.query("ROLLBACK");
    console.error("Stock adjust error:", err);
    res.status(500).json({ message: "Adjustment failed" });
  } finally {
    client.release();
  }
};


/* ─────────────────────────────────────────────────────────
   STOCK LOGS — all movements (Stock Logs page)
   ?stock_item_id=X   filter by item
   ?action=STOCK_IN   filter by action
   ───────────────────────────────────────────────────────── */
exports.getStockLogs = async (req, res) => {
  try {
    const { stock_item_id, action, limit = 100, offset = 0 } = req.query;

    const params = [];
    const conditions = [];

    if (stock_item_id) {
      params.push(stock_item_id);
      conditions.push(`sl.stock_item_id = $${params.length}`);
    }
    if (action) {
      params.push(action);
      conditions.push(`sl.action = $${params.length}`);
    }

    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';

    const data = await DB.PostgresAny(`
      SELECT
        sl.id,
        sl.stock_item_id,
        si.name       AS item_name,
        sl.change_qty,
        si.unit_label AS unit,
        sl.action,
        sl.reason,
        sl.note,
        sl.reference_id,
        sl.stock_entry_id,
        sl.created_at
      FROM stock_logs sl
      JOIN stock_items si ON si.id = sl.stock_item_id
      ${where}
      ORDER BY sl.created_at DESC
      LIMIT $${params.length + 1} OFFSET $${params.length + 2}
    `, [...params, Number(limit), Number(offset)]);

    res.json(data);
  } catch (err) {
    console.error("Get stock logs error:", err);
    res.status(500).json({ message: "Failed to get stock logs" });
  }
};
