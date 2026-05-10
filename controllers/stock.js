const DB = require("../middleware/dbFunctions");

/* =========================================================
   STOCK CONTROLLER (per shop)
   ========================================================= */

exports.getStock = async (req, res) => {
  try {
    const data = await DB.PostgresAny(`
      SELECT
        si.id, si.name,
        c.name AS category_name,
        si.base_unit, si.unit_label, si.unit_value,
        ROUND(si.current_qty, 2) AS current_qty,
        ROUND(si.min_qty, 2)     AS min_qty,
        si.current_qty <= si.min_qty AS is_low_stock,
        (SELECT MIN(se.expiry_date)
           FROM stock_entries se
          WHERE se.stock_item_id = si.id AND se.shop_id = si.shop_id
            AND se.remaining_qty > 0 AND se.expiry_date IS NOT NULL
        ) AS nearest_expiry,
        (SELECT COUNT(*)
           FROM stock_entries se
          WHERE se.stock_item_id = si.id AND se.shop_id = si.shop_id
            AND se.remaining_qty > 0 AND se.expiry_date IS NOT NULL
            AND se.expiry_date <= CURRENT_DATE + INTERVAL '7 days'
        ) AS expiring_count
      FROM stock_items si
      LEFT JOIN categories c ON c.id = si.category_id
      WHERE si.is_active = true AND si.shop_id = $1
      ORDER BY si.current_qty <= si.min_qty DESC, si.name ASC
    `, [req.shop_id]);
    res.json(data);
  } catch (err) {
    console.error("Get stock error:", err);
    res.status(500).json({ message: "Failed to get stock" });
  }
};

exports.getDropDownStock = async (req, res) => {
  try {
    const data = await DB.PostgresAny(`
      SELECT id, name, base_unit, unit_label, unit_value,
             ROUND(current_qty, 2) AS current_qty
      FROM stock_items
      WHERE is_active = true AND shop_id = $1
      ORDER BY name
    `, [req.shop_id]);
    res.json(data);
  } catch (err) {
    console.error("Get dropdown error:", err);
    res.status(500).json({ message: "Failed" });
  }
};

exports.adjustStock = async (req, res) => {
  const client = await DB.getClient();
  const shopId = req.shop_id;
  try {
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
      WHERE id = $2 AND is_active = true AND shop_id = $3
      RETURNING current_qty, name
    `, [change_qty, stock_item_id, shopId]);

    if (!result.rows.length) {
      await client.query("ROLLBACK");
      return res.status(400).json({ message: "Stock item not found" });
    }

    await client.query(`
      INSERT INTO stock_logs (stock_item_id, change_qty, action, note, shop_id)
      VALUES ($1, $2, $3, $4, $5)
    `, [stock_item_id, change_qty, logReason, note || null, shopId]);

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

exports.addStockEntry = async (req, res) => {
  const client = await DB.getClient();
  const shopId = req.shop_id;
  try {
    const {
      qty, purchase_price, purchase_date,
      expiry_date, supplier, batch_no, notes
    } = req.body;

    const stock_item_id = req.body.stock_item_id || req.body.product_id;

    if (!stock_item_id || !qty || purchase_price == null) {
      return res.status(400).json({ message: "product_id, qty, purchase_price are required" });
    }

    const item = await DB.PostgresAny(
      `SELECT id, name, base_unit, unit_label FROM stock_items WHERE id = $1 AND shop_id = $2`,
      [stock_item_id, shopId]
    );
    if (!item.length) return res.status(404).json({ message: "Stock item not found" });

    const { unit_label, base_unit, name } = item[0];
    // qty is already the total in the item's unit (frontend sends packs × qty_per_pack)
    const base_qty = Number(qty);

    await client.query("BEGIN");

    const entryRes = await client.query(`
      INSERT INTO stock_entries
        (stock_item_id, qty, unit, base_qty, remaining_qty,
         purchase_price, purchase_date, expiry_date, supplier, batch_no, notes, shop_id)
      VALUES ($1,$2,$3,$4,$4,$5,$6,$7,$8,$9,$10,$11)
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
      notes          || null,
      shopId
    ]);

    await client.query(`
      UPDATE stock_items SET current_qty = current_qty + $1, updated_at = NOW() WHERE id = $2 AND shop_id = $3
    `, [base_qty, stock_item_id, shopId]);

    const logNote = [
      `Added ${qty} ${unit_label}`,
      supplier    ? `from ${supplier}`       : null,
      expiry_date ? `expires ${expiry_date}` : null,
      `@ ₹${purchase_price}/${unit_label}`
    ].filter(Boolean).join(' | ');

    await client.query(`
      INSERT INTO stock_logs (stock_item_id, stock_entry_id, change_qty, action, note, shop_id)
      VALUES ($1, $2, $3, 'STOCK_IN', $4, $5)
    `, [stock_item_id, entryRes.rows[0].id, base_qty, logNote, shopId]);

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

exports.addStockEntryBulk = async (req, res) => {
  const client = await DB.getClient();
  const shopId = req.shop_id;
  try {
    const stock_item_id = req.body.stock_item_id || req.body.product_id;
    const { purchase_date, supplier, entries } = req.body;

    if (!stock_item_id || !Array.isArray(entries) || !entries.length) {
      return res.status(400).json({ message: "stock_item_id and entries[] are required" });
    }

    for (const e of entries) {
      if (!e.qty || e.purchase_price == null) {
        return res.status(400).json({ message: "Each entry must have qty and purchase_price" });
      }
    }

    const item = await DB.PostgresAny(
      `SELECT id, name, base_unit, unit_label FROM stock_items WHERE id = $1 AND shop_id = $2`,
      [stock_item_id, shopId]
    );
    if (!item.length) return res.status(404).json({ message: "Stock item not found" });

    const { unit_label, base_unit, name } = item[0];
    const today = new Date().toISOString().split('T')[0];
    const pDate = purchase_date || today;

    await client.query("BEGIN");

    let totalBaseQty = 0;
    const addedEntries = [];

    for (const e of entries) {
      // qty is already the total in the item's unit (packs × qty_per_pack computed by caller)
      const base_qty = Number(e.qty);
      totalBaseQty += base_qty;

      const entryRes = await client.query(`
        INSERT INTO stock_entries
          (stock_item_id, qty, unit, base_qty, remaining_qty,
           purchase_price, purchase_date, expiry_date, supplier, batch_no, notes, shop_id)
        VALUES ($1,$2,$3,$4,$4,$5,$6,$7,$8,$9,$10,$11)
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
        e.notes        || null,
        shopId
      ]);

      const logNote = [
        `Added ${e.qty} ${unit_label}`,
        (supplier || e.supplier) ? `from ${supplier || e.supplier}` : null,
        e.expiry_date ? `expires ${e.expiry_date}` : null,
        `@ ₹${e.purchase_price}/${unit_label}`
      ].filter(Boolean).join(' | ');

      await client.query(`
        INSERT INTO stock_logs (stock_item_id, stock_entry_id, change_qty, action, note, shop_id)
        VALUES ($1, $2, $3, 'STOCK_IN', $4, $5)
      `, [stock_item_id, entryRes.rows[0].id, base_qty, logNote, shopId]);

      addedEntries.push({
        entry_id:    entryRes.rows[0].id,
        qty:         e.qty,
        expiry_date: e.expiry_date || null,
        batch_no:    e.batch_no    || null,
        base_qty
      });
    }

    await client.query(`
      UPDATE stock_items SET current_qty = current_qty + $1, updated_at = NOW() WHERE id = $2 AND shop_id = $3
    `, [totalBaseQty, stock_item_id, shopId]);

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

exports.updateStockEntry = async (req, res) => {
  try {
    const id = Number(req.params.id);
    const shopId = req.shop_id;
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

    params.push(id, shopId);
    const result = await DB.PostgresAny(`
      UPDATE stock_entries
      SET ${fields.join(', ')}
      WHERE id = $${params.length - 1} AND shop_id = $${params.length}
      RETURNING
        id, expiry_date, batch_no, supplier, notes,
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

exports.deleteStockEntry = async (req, res) => {
  const client = await DB.getClient();
  try {
    const id     = Number(req.params.id);
    const shopId = req.shop_id;

    const entry = await DB.PostgresAny(
      `SELECT se.*, si.name AS item_name, si.unit_label
       FROM stock_entries se
       JOIN stock_items si ON si.id = se.stock_item_id
       WHERE se.id = $1 AND se.shop_id = $2`,
      [id, shopId]
    );
    if (!entry.length) return res.status(404).json({ message: "Entry not found" });

    const e          = entry[0];
    const reverseQty = Number(e.remaining_qty);

    await client.query("BEGIN");

    // Nullify FK reference before deleting (stock_logs.stock_entry_id → stock_entries.id)
    await client.query(`UPDATE stock_logs SET stock_entry_id = NULL WHERE stock_entry_id = $1`, [id]);

    await client.query(`DELETE FROM stock_entries WHERE id = $1 AND shop_id = $2`, [id, shopId]);

    if (reverseQty > 0) {
      await client.query(`
        UPDATE stock_items SET current_qty = current_qty - $1, updated_at = NOW()
        WHERE id = $2 AND shop_id = $3
      `, [reverseQty, e.stock_item_id, shopId]);

      await client.query(`
        INSERT INTO stock_logs (stock_item_id, change_qty, action, note, shop_id)
        VALUES ($1, $2, 'ADJUSTMENT', $3, $4)
      `, [e.stock_item_id, -reverseQty,
          `Purchase entry #${id} deleted (reversed ${reverseQty} ${e.unit_label})`, shopId]);
    }

    await client.query("COMMIT");
    res.json({ message: "Entry deleted", reversed_qty: reverseQty });
  } catch (err) {
    await client.query("ROLLBACK");
    console.error("Delete stock entry error:", err);
    res.status(500).json({ message: "Failed to delete entry" });
  } finally {
    client.release();
  }
};

exports.getStockEntries = async (req, res) => {
  try {
    const stock_item_id = req.query.stock_item_id || req.query.product_id;
    const { page = 1, limit = 20, search } = req.query;
    const shopId = req.shop_id;

    const pageNo   = Number(page);
    const pageSize = Number(limit);
    const offset   = (pageNo - 1) * pageSize;

    const params = [shopId];
    let where = `WHERE se.shop_id = $1`;
    if (stock_item_id) {
      params.push(stock_item_id);
      where += ` AND se.stock_item_id = $${params.length}`;
    }
    if (search) {
      params.push(`%${search}%`);
      const idx = params.length;
      where += ` AND (si.name ILIKE $${idx} OR se.supplier ILIKE $${idx} OR se.batch_no ILIKE $${idx})`;
    }

    const entries = await DB.PostgresAny(`
      SELECT
        se.id,
        se.stock_item_id          AS product_id,
        si.name                   AS item_name,
        si.base_unit,
        se.qty, se.unit, se.base_qty,
        ROUND(se.remaining_qty,2) AS remaining_qty,
        se.purchase_price, se.purchase_date, se.expiry_date,
        se.supplier, se.batch_no, se.notes, se.created_at,
        (se.expiry_date - CURRENT_DATE) AS days_to_expiry,
        CASE
          WHEN se.expiry_date IS NULL                                        THEN 'NO_EXPIRY'
          WHEN se.expiry_date < CURRENT_DATE                                 THEN 'EXPIRED'
          WHEN se.expiry_date <= CURRENT_DATE + INTERVAL '3 days'            THEN 'EXPIRING_TODAY'
          WHEN se.expiry_date <= CURRENT_DATE + INTERVAL '7 days'            THEN 'EXPIRING_SOON'
          ELSE                                                                    'OK'
        END AS expiry_status
      FROM stock_entries se
      JOIN stock_items si ON si.id = se.stock_item_id
      ${where}
      ORDER BY se.purchase_date DESC, se.created_at DESC
      LIMIT $${params.length + 1} OFFSET $${params.length + 2}
    `, [...params, pageSize, offset]);

    const count = await DB.PostgresAny(
      `SELECT COUNT(*) AS total FROM stock_entries se JOIN stock_items si ON si.id = se.stock_item_id ${where}`, params
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

exports.getPriceHistory = async (req, res) => {
  try {
    const data = await DB.PostgresAny(`
      SELECT
        se.id, se.purchase_date, se.qty, se.unit,
        se.purchase_price, se.supplier, se.batch_no,
        si.name AS item_name
      FROM stock_entries se
      JOIN stock_items si ON si.id = se.stock_item_id
      WHERE se.stock_item_id = $1 AND se.shop_id = $2
      ORDER BY se.purchase_date DESC, se.created_at DESC
    `, [req.params.stock_item_id || req.params.product_id, req.shop_id]);
    res.json(data);
  } catch (err) {
    console.error("Price history error:", err);
    res.status(500).json({ message: "Failed" });
  }
};

exports.getExpiringEntries = async (req, res) => {
  try {
    const days = Number(req.query.days) || 7;
    const data = await DB.PostgresAny(`
      SELECT
        se.id,
        si.name AS item_name,
        si.base_unit,
        se.qty, se.unit, se.remaining_qty,
        se.purchase_price, se.purchase_date, se.expiry_date,
        se.supplier, se.batch_no,
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
        AND se.shop_id = $2
      ORDER BY se.expiry_date ASC
    `, [days, req.shop_id]);
    res.json(data);
  } catch (err) {
    console.error("Get expiring error:", err);
    res.status(500).json({ message: "Failed" });
  }
};

exports.getAlerts = async (req, res) => {
  try {
    const shopId = req.shop_id;

    const expiring = await DB.PostgresAny(`
      SELECT
        se.id,
        si.name AS item_name,
        si.base_unit,
        se.qty, se.unit,
        ROUND(se.remaining_qty, 2) AS remaining_qty,
        se.expiry_date, se.supplier, se.batch_no,
        (se.expiry_date - CURRENT_DATE) AS days_to_expiry,
        CASE
          WHEN se.expiry_date < CURRENT_DATE                      THEN 'EXPIRED'
          WHEN se.expiry_date <= CURRENT_DATE + INTERVAL '3 days' THEN 'EXPIRING_TODAY'
          WHEN se.expiry_date <= CURRENT_DATE + INTERVAL '7 days' THEN 'EXPIRING_SOON'
          ELSE                                                          'EXPIRING_30'
        END AS status
      FROM stock_entries se
      JOIN stock_items si ON si.id = se.stock_item_id
      WHERE se.remaining_qty > 0
        AND se.expiry_date IS NOT NULL
        AND se.expiry_date <= CURRENT_DATE + INTERVAL '30 days'
        AND se.shop_id = $1
      ORDER BY se.expiry_date ASC
    `, [shopId]);

    const low_stock = await DB.PostgresAny(`
      SELECT
        si.id, si.name, si.base_unit, si.unit_label,
        ROUND(si.current_qty, 2) AS current_qty,
        ROUND(si.min_qty, 2)     AS min_qty
      FROM stock_items si
      WHERE si.is_active = true
        AND si.current_qty <= si.min_qty
        AND si.shop_id = $1
      ORDER BY si.current_qty ASC
    `, [shopId]);

    res.json({
      expiring,
      low_stock,
      expiring_count: expiring.length,
      low_stock_count: low_stock.length
    });
  } catch (err) {
    console.error("Get alerts error:", err);
    res.status(500).json({ message: "Failed to get alerts" });
  }
};

exports.getStockLogs = async (req, res) => {
  try {
    const stock_item_id = req.query.stock_item_id || req.query.product_id;
    const { action, limit = 100, offset = 0 } = req.query;
    const shopId = req.shop_id;

    const params = [shopId];
    const conds  = [`sl.shop_id = $1`];

    if (stock_item_id) { params.push(stock_item_id); conds.push(`sl.stock_item_id = $${params.length}`); }
    if (action)        { params.push(action);         conds.push(`sl.action = $${params.length}`); }

    const where = `WHERE ${conds.join(' AND ')}`;

    const data = await DB.PostgresAny(`
      SELECT
        sl.id,
        sl.stock_item_id  AS product_id,
        si.name           AS item_name,
        sl.change_qty,
        si.unit_label     AS unit,
        sl.action, sl.reason, sl.note,
        sl.reference_id, sl.stock_entry_id, sl.created_at
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
