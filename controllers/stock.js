const DB = require("../middleware/dbFunctions");

/* =========================================================
   STOCK CONTROLLER
   All existing API contracts are preserved:
     GET  /stock               → same fields as before
     GET  /stock_dropdown      → same fields as before
     POST /stock/adjust        → still accepts product_id

   Data source changed from products table → stock_items table
   IDs are the same after migration so frontend sees no difference.

   New APIs added (for new stock page):
     POST /stock/add           → receive stock (qty + price + expiry)
     GET  /stock/entries       → purchase history
     GET  /stock/price-history/:id
     GET  /stock/expiring
     GET  /stock/logs
   ========================================================= */


/* ─────────────────────────────────────────────────────────
   GET STOCK LIST  — existing contract kept
   Returns: id, name, category_name, base_unit, unit_label,
            unit_value, current_qty, min_qty
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
        (SELECT MIN(se.expiry_date)
           FROM stock_entries se
          WHERE se.stock_item_id = si.id
            AND se.remaining_qty > 0
            AND se.expiry_date IS NOT NULL
        )                                   AS nearest_expiry,
        (SELECT COUNT(*)
           FROM stock_entries se
          WHERE se.stock_item_id = si.id
            AND se.remaining_qty > 0
            AND se.expiry_date IS NOT NULL
            AND se.expiry_date <= CURRENT_DATE + INTERVAL '7 days'
        )                                   AS expiring_count
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
   GET STOCK DROPDOWN  — existing contract kept
   Used by product page recipe builder (raw_product_id)
   ───────────────────────────────────────────────────────── */
exports.getDropDownStock = async (_req, res) => {
  try {
    const data = await DB.PostgresAny(`
      SELECT
        id,
        name,
        base_unit,
        unit_label,
        unit_value,
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
   ADJUST STOCK  — existing contract kept
   Accepts product_id (same ID as stock_item_id after migration)
   ───────────────────────────────────────────────────────── */
exports.adjustStock = async (req, res) => {
  const client = await DB.getClient();
  try {
    // Accept both product_id (old) and stock_item_id (new) — same value
    const stock_item_id = req.body.stock_item_id || req.body.product_id;
    const { change_qty, reason, note } = req.body;

    if (!stock_item_id || change_qty == null) {
      return res.status(400).json({ message: "product_id and change_qty required" });
    }

    const validReasons = ['DAILY_REFILL', 'WASTAGE', 'ADJUSTMENT'];
    const logReason    = validReasons.includes(reason) ? reason : 'ADJUSTMENT';

    await client.query("BEGIN");

    const result = await client.query(`
      UPDATE stock_items
      SET current_qty = current_qty + $1, updated_at = NOW()
      WHERE id = $2 AND is_active = true
      RETURNING current_qty, name
    `, [change_qty, stock_item_id]);

    if (!result.rows.length) {
      await client.query("ROLLBACK");
      return res.status(400).json({ message: "Stock item not found" });
    }

    await client.query(`
      INSERT INTO stock_logs (stock_item_id, change_qty, action, note)
      VALUES ($1, $2, $3, $4)
    `, [stock_item_id, change_qty, logReason, note || null]);

    await client.query("COMMIT");

    res.json({
      message:     "Stock updated",
      current_qty: result.rows[0].current_qty
    });
  } catch (err) {
    await client.query("ROLLBACK");
    console.error("Stock adjust error:", err);
    res.status(500).json({ message: "Stock update failed" });
  } finally {
    client.release();
  }
};


/* ─────────────────────────────────────────────────────────
   ADD STOCK ENTRY  — single entry
   POST /stock/add
   Body:
     stock_item_id (or product_id)
     qty, purchase_price, purchase_date
     expiry_date, supplier, batch_no, notes  (all optional)
   ───────────────────────────────────────────────────────── */
exports.addStockEntry = async (req, res) => {
  const client = await DB.getClient();
  try {
    const {
      qty, purchase_price, purchase_date,
      expiry_date, supplier, batch_no, notes
    } = req.body;

    const stock_item_id = req.body.stock_item_id || req.body.product_id;

    if (!stock_item_id || !qty || purchase_price == null) {
      return res.status(400).json({
        message: "product_id, qty, purchase_price are required"
      });
    }

    const item = await DB.PostgresAny(
      `SELECT id, name, base_unit, unit_label, unit_value FROM stock_items WHERE id = $1`,
      [stock_item_id]
    );
    if (!item.length) return res.status(404).json({ message: "Stock item not found" });

    const { unit_value, unit_label, base_unit, name } = item[0];
    // Convert to base_qty: 5 kg × 1000 = 5000 gm
    const base_qty = Number(qty) * Number(unit_value);

    await client.query("BEGIN");

    const entryRes = await client.query(`
      INSERT INTO stock_entries
        (stock_item_id, qty, unit, base_qty, remaining_qty,
         purchase_price, purchase_date, expiry_date, supplier, batch_no, notes)
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

    await client.query(`
      UPDATE stock_items SET current_qty = current_qty + $1, updated_at = NOW() WHERE id = $2
    `, [base_qty, stock_item_id]);

    const logNote = [
      `Added ${qty} ${unit_label}`,
      supplier    ? `from ${supplier}`       : null,
      expiry_date ? `expires ${expiry_date}` : null,
      `@ ₹${purchase_price}/${unit_label}`
    ].filter(Boolean).join(' | ');

    await client.query(`
      INSERT INTO stock_logs (stock_item_id, stock_entry_id, change_qty, action, note)
      VALUES ($1, $2, $3, 'STOCK_IN', $4)
    `, [stock_item_id, entryRes.rows[0].id, base_qty, logNote]);

    await client.query("COMMIT");

    const updated = await DB.PostgresAny(
      `SELECT current_qty FROM stock_items WHERE id = $1`, [stock_item_id]
    );

    res.status(201).json({
      message:   "Stock added",
      entry_id:  entryRes.rows[0].id,
      item:      name,
      qty_added: `${qty} ${unit_label}`,
      base_qty,
      base_unit,
      new_total: updated[0].current_qty
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
   ADD STOCK — MULTIPLE BATCHES IN ONE CALL
   POST /stock/add-bulk
   Use when the same purchase has different expiry dates per batch.

   Body:
     stock_item_id (or product_id)
     purchase_date : shared purchase date (optional, defaults today)
     supplier      : shared supplier     (optional)
     entries: [
       { qty, purchase_price, expiry_date, batch_no, notes },
       { qty, purchase_price, expiry_date, batch_no, notes },
       ...
     ]

   Example — 10 kg sugar, 6 kg expires Apr-15, 4 kg expires May-01:
   {
     "stock_item_id": 3,
     "supplier": "Raja Traders",
     "purchase_date": "2026-03-28",
     "entries": [
       { "qty": 6, "purchase_price": 45, "expiry_date": "2026-04-15", "batch_no": "B001" },
       { "qty": 4, "purchase_price": 45, "expiry_date": "2026-05-01", "batch_no": "B002" }
     ]
   }
   ───────────────────────────────────────────────────────── */
exports.addStockEntryBulk = async (req, res) => {
  const client = await DB.getClient();
  try {
    const stock_item_id = req.body.stock_item_id || req.body.product_id;
    const { purchase_date, supplier, entries } = req.body;

    if (!stock_item_id || !Array.isArray(entries) || !entries.length) {
      return res.status(400).json({
        message: "stock_item_id and entries[] are required"
      });
    }

    for (const e of entries) {
      if (!e.qty || e.purchase_price == null) {
        return res.status(400).json({
          message: "Each entry must have qty and purchase_price"
        });
      }
    }

    const item = await DB.PostgresAny(
      `SELECT id, name, base_unit, unit_label, unit_value FROM stock_items WHERE id = $1`,
      [stock_item_id]
    );
    if (!item.length) return res.status(404).json({ message: "Stock item not found" });

    const { unit_value, unit_label, base_unit, name } = item[0];
    const today = new Date().toISOString().split('T')[0];
    const pDate = purchase_date || today;

    await client.query("BEGIN");

    let totalBaseQty = 0;
    const addedEntries = [];

    for (const e of entries) {
      const base_qty = Number(e.qty) * Number(unit_value);
      totalBaseQty += base_qty;

      const entryRes = await client.query(`
        INSERT INTO stock_entries
          (stock_item_id, qty, unit, base_qty, remaining_qty,
           purchase_price, purchase_date, expiry_date, supplier, batch_no, notes)
        VALUES ($1,$2,$3,$4,$4,$5,$6,$7,$8,$9,$10)
        RETURNING id
      `, [
        stock_item_id,
        Number(e.qty),
        unit_label,
        base_qty,
        Number(e.purchase_price),
        pDate,
        e.expiry_date  || null,
        supplier       || e.supplier || null,
        e.batch_no     || null,
        e.notes        || null
      ]);

      const logNote = [
        `Added ${e.qty} ${unit_label}`,
        (supplier || e.supplier) ? `from ${supplier || e.supplier}` : null,
        e.expiry_date ? `expires ${e.expiry_date}` : null,
        `@ ₹${e.purchase_price}/${unit_label}`
      ].filter(Boolean).join(' | ');

      await client.query(`
        INSERT INTO stock_logs (stock_item_id, stock_entry_id, change_qty, action, note)
        VALUES ($1, $2, $3, 'STOCK_IN', $4)
      `, [stock_item_id, entryRes.rows[0].id, base_qty, logNote]);

      addedEntries.push({
        entry_id:    entryRes.rows[0].id,
        qty:         e.qty,
        expiry_date: e.expiry_date || null,
        batch_no:    e.batch_no    || null,
        base_qty
      });
    }

    /* Update current_qty once with total */
    await client.query(`
      UPDATE stock_items SET current_qty = current_qty + $1, updated_at = NOW() WHERE id = $2
    `, [totalBaseQty, stock_item_id]);

    await client.query("COMMIT");

    const updated = await DB.PostgresAny(
      `SELECT current_qty FROM stock_items WHERE id = $1`, [stock_item_id]
    );

    res.status(201).json({
      message:         "Stock added",
      item:            name,
      entries_created: addedEntries.length,
      total_base_qty:  totalBaseQty,
      base_unit,
      new_total:       updated[0].current_qty,
      entries:         addedEntries
    });
  } catch (err) {
    await client.query("ROLLBACK");
    console.error("Add stock bulk error:", err);
    res.status(500).json({ message: "Failed to add stock", error: err.message });
  } finally {
    client.release();
  }
};


/* ─────────────────────────────────────────────────────────
   UPDATE STOCK ENTRY  — patch expiry_date, batch_no, supplier, notes
   PATCH /stock/entries/:id
   ───────────────────────────────────────────────────────── */
exports.updateStockEntry = async (req, res) => {
  try {
    const id = Number(req.params.id);
    const { expiry_date, batch_no, supplier, notes } = req.body;

    const fields = [];
    const params = [];

    if (expiry_date !== undefined) {
      params.push(expiry_date || null);
      fields.push(`expiry_date = $${params.length}`);
    }
    if (batch_no !== undefined) {
      params.push(batch_no || null);
      fields.push(`batch_no = $${params.length}`);
    }
    if (supplier !== undefined) {
      params.push(supplier || null);
      fields.push(`supplier = $${params.length}`);
    }
    if (notes !== undefined) {
      params.push(notes || null);
      fields.push(`notes = $${params.length}`);
    }

    if (!fields.length) {
      return res.status(400).json({ message: "Nothing to update" });
    }

    params.push(id);
    const result = await DB.PostgresAny(`
      UPDATE stock_entries
      SET ${fields.join(', ')}
      WHERE id = $${params.length}
      RETURNING
        id,
        expiry_date,
        batch_no,
        supplier,
        notes,
        CASE
          WHEN expiry_date IS NULL                                        THEN 'NO_EXPIRY'
          WHEN expiry_date < CURRENT_DATE                                 THEN 'EXPIRED'
          WHEN expiry_date <= CURRENT_DATE + INTERVAL '3 days'            THEN 'EXPIRING_TODAY'
          WHEN expiry_date <= CURRENT_DATE + INTERVAL '7 days'            THEN 'EXPIRING_SOON'
          ELSE                                                                 'OK'
        END AS expiry_status
    `, params);

    if (!result.length) return res.status(404).json({ message: "Entry not found" });

    res.json({ message: "Entry updated", entry: result[0] });
  } catch (err) {
    console.error("Update stock entry error:", err);
    res.status(500).json({ message: "Failed to update entry" });
  }
};


/* ─────────────────────────────────────────────────────────
   STOCK ENTRIES LIST  — NEW (purchase history + price tracking)
   ?product_id=X or ?stock_item_id=X
   ───────────────────────────────────────────────────────── */
exports.getStockEntries = async (req, res) => {
  try {
    const stock_item_id = req.query.stock_item_id || req.query.product_id;
    const { page = 1, limit = 20 } = req.query;

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
        se.stock_item_id          AS product_id,
        si.name                   AS item_name,
        si.base_unit,
        se.qty,
        se.unit,
        se.base_qty,
        ROUND(se.remaining_qty,2) AS remaining_qty,
        se.purchase_price,
        se.purchase_date,
        se.expiry_date,
        se.supplier,
        se.batch_no,
        se.notes,
        se.created_at,
        (se.expiry_date - CURRENT_DATE) AS days_to_expiry,
        CASE
          WHEN se.expiry_date IS NULL                                        THEN 'NO_EXPIRY'
          WHEN se.expiry_date < CURRENT_DATE                                 THEN 'EXPIRED'
          WHEN se.expiry_date <= CURRENT_DATE + INTERVAL '3 days'            THEN 'EXPIRING_TODAY'
          WHEN se.expiry_date <= CURRENT_DATE + INTERVAL '7 days'            THEN 'EXPIRING_SOON'
          ELSE                                                                    'OK'
        END                       AS expiry_status
      FROM stock_entries se
      JOIN stock_items si ON si.id = se.stock_item_id
      ${where}
      ORDER BY se.purchase_date DESC, se.created_at DESC
      LIMIT $${params.length + 1} OFFSET $${params.length + 2}
    `, [...params, pageSize, offset]);

    const count = await DB.PostgresAny(
      `SELECT COUNT(*) AS total FROM stock_entries se ${where}`, params
    );

    res.json({
      data:       entries,
      total:      Number(count[0].total),
      page:       pageNo,
      totalPages: Math.ceil(Number(count[0].total) / pageSize)
    });
  } catch (err) {
    console.error("Get stock entries error:", err);
    res.status(500).json({ message: "Failed to get entries" });
  }
};


/* ─────────────────────────────────────────────────────────
   PRICE HISTORY  — NEW (track price changes over time)
   GET /stock/price-history/:product_id
   ───────────────────────────────────────────────────────── */
exports.getPriceHistory = async (req, res) => {
  try {
    const data = await DB.PostgresAny(`
      SELECT
        se.id,
        se.purchase_date,
        se.qty,
        se.unit,
        se.purchase_price,
        se.supplier,
        se.batch_no,
        si.name AS item_name
      FROM stock_entries se
      JOIN stock_items si ON si.id = se.stock_item_id
      WHERE se.stock_item_id = $1
      ORDER BY se.purchase_date DESC, se.created_at DESC
    `, [req.params.stock_item_id || req.params.product_id]);
    res.json(data);
  } catch (err) {
    console.error("Price history error:", err);
    res.status(500).json({ message: "Failed" });
  }
};


/* ─────────────────────────────────────────────────────────
   EXPIRY ALERTS  — NEW
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
    res.status(500).json({ message: "Failed" });
  }
};


/* ─────────────────────────────────────────────────────────
   STOCK LOGS  — NEW (separate page, all movements)
   GET /stock/logs?product_id=X&action=STOCK_IN
   ───────────────────────────────────────────────────────── */
exports.getStockLogs = async (req, res) => {
  try {
    const stock_item_id = req.query.stock_item_id || req.query.product_id;
    const { action, limit = 100, offset = 0 } = req.query;

    const params = [];
    const conds  = [];

    if (stock_item_id) { params.push(stock_item_id); conds.push(`sl.stock_item_id = $${params.length}`); }
    if (action)        { params.push(action);         conds.push(`sl.action = $${params.length}`); }

    const where = conds.length ? `WHERE ${conds.join(' AND ')}` : '';

    const data = await DB.PostgresAny(`
      SELECT
        sl.id,
        sl.stock_item_id  AS product_id,
        si.name           AS item_name,
        sl.change_qty,
        si.unit_label     AS unit,
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
    res.status(500).json({ message: "Failed to get logs" });
  }
};
