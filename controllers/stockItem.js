const DB = require("../middleware/dbFunctions");

/* =========================================================
   STOCK ITEMS  — raw materials / inventory
   Saved in: stock_items table  (separate from products)

   Stock quantity changes ONLY through:
     POST /stock/receive   — receive batch (with expiry date)
     POST /stock/adjust    — manual correction (with reason)
     Billing               — auto-deducted when bill completed
   ========================================================= */


/* ─────────────────────────────────────────────────────────
   LIST ALL STOCK ITEMS
   ?search=    filter by name
   ?low_stock=true   only items below min_qty
   ───────────────────────────────────────────────────────── */
exports.getAllStockItems = async (req, res) => {
  try {
    const { search = '', low_stock, page = 1, limit = 20 } = req.query;

    const pageNo   = Number(page);
    const pageSize = Number(limit);
    const offset   = (pageNo - 1) * pageSize;

    let where  = `WHERE si.is_active = true`;
    const params = [];

    if (search) {
      params.push(`%${search.toLowerCase()}%`);
      where += ` AND LOWER(si.name) LIKE $${params.length}`;
    }
    if (low_stock === 'true') {
      where += ` AND si.current_qty <= si.min_qty`;
    }

    const items = await DB.PostgresAny(`
      SELECT
        si.id,
        si.name,
        si.category_id,
        c.name                               AS category_name,

        si.base_unit,
        si.unit_label,
        si.unit_value,

        ROUND(si.current_qty, 2)             AS current_qty,
        ROUND(si.min_qty, 2)                 AS min_qty,
        si.current_qty <= si.min_qty         AS is_low_stock,

        -- count of active batches
        (SELECT COUNT(*) FROM stock_batches sb
          WHERE sb.stock_item_id = si.id AND sb.remaining_qty > 0
        )                                    AS active_batch_count,

        -- batches expiring within 7 days
        (SELECT COUNT(*) FROM stock_batches sb
          WHERE sb.stock_item_id = si.id
            AND sb.remaining_qty > 0
            AND sb.expiry_date IS NOT NULL
            AND sb.expiry_date <= CURRENT_DATE + INTERVAL '7 days'
        )                                    AS expiring_batch_count,

        -- any expired batch still holding stock
        EXISTS (
          SELECT 1 FROM stock_batches sb
          WHERE sb.stock_item_id = si.id
            AND sb.remaining_qty > 0
            AND sb.expiry_date IS NOT NULL
            AND sb.expiry_date < CURRENT_DATE
        )                                    AS has_expired_stock,

        si.is_active,
        si.updated_at
      FROM stock_items si
      LEFT JOIN categories c ON c.id = si.category_id
      ${where}
      ORDER BY si.current_qty <= si.min_qty DESC, si.name ASC
      LIMIT $${params.length + 1} OFFSET $${params.length + 2}
    `, [...params, pageSize, offset]);

    const count = await DB.PostgresAny(
      `SELECT COUNT(*) AS total FROM stock_items si ${where}`,
      params
    );

    const lowStockCount = await DB.PostgresAny(`
      SELECT COUNT(*) AS total FROM stock_items
      WHERE is_active = true AND current_qty <= min_qty
    `, []);

    res.json({
      data:            items,
      page:            pageNo,
      limit:           pageSize,
      total:           Number(count[0].total),
      totalPages:      Math.ceil(Number(count[0].total) / pageSize),
      low_stock_count: Number(lowStockCount[0].total)
    });

  } catch (err) {
    console.error("Get stock items error:", err);
    res.status(500).json({ msg: "Server error" });
  }
};


/* ─────────────────────────────────────────────────────────
   GET SINGLE STOCK ITEM
   Returns item detail + last 10 batches + last 20 log entries
   ───────────────────────────────────────────────────────── */
exports.getStockItemById = async (req, res) => {
  try {
    const id = Number(req.params.id);

    const item = await DB.PostgresAny(`
      SELECT si.*, c.name AS category_name
      FROM stock_items si
      LEFT JOIN categories c ON c.id = si.category_id
      WHERE si.id = $1
    `, [id]);

    if (!item.length) return res.status(404).json({ msg: "Stock item not found" });

    const batches = await DB.PostgresAny(`
      SELECT
        id, batch_no, supplier, purchase_date, expiry_date,
        received_unit, received_qty, base_qty, remaining_qty,
        cost_price, notes,
        (expiry_date - CURRENT_DATE) AS days_to_expiry,
        CASE
          WHEN expiry_date IS NULL                                         THEN 'NO_EXPIRY'
          WHEN expiry_date < CURRENT_DATE                                  THEN 'EXPIRED'
          WHEN expiry_date <= CURRENT_DATE + INTERVAL '3 days'             THEN 'EXPIRING_TODAY'
          WHEN expiry_date <= CURRENT_DATE + INTERVAL '7 days'             THEN 'EXPIRING_SOON'
          ELSE                                                                  'OK'
        END AS expiry_status
      FROM stock_batches
      WHERE stock_item_id = $1
      ORDER BY created_at DESC
      LIMIT 10
    `, [id]);

    const logs = await DB.PostgresAny(`
      SELECT id, change_qty, action, reason, note, reference_id, created_at
      FROM stock_logs
      WHERE stock_item_id = $1
      ORDER BY created_at DESC
      LIMIT 20
    `, [id]);

    res.json({ ...item[0], batches, logs });

  } catch (err) {
    console.error("Get stock item error:", err);
    res.status(500).json({ msg: "Server error" });
  }
};


/* ─────────────────────────────────────────────────────────
   CREATE STOCK ITEM  (Add button on stock page)

   Unit examples:
     Sugar (kg bags):     base_unit=gm,  unit_label=kg,     unit_value=1000
     Milk (litres):       base_unit=ml,  unit_label=litre,  unit_value=1000
     Packets (100gm):     base_unit=gm,  unit_label=packet, unit_value=100
     Cups (pcs):          base_unit=pcs, unit_label=piece,  unit_value=1
   ───────────────────────────────────────────────────────── */
exports.createStockItem = async (req, res) => {
  try {
    const { name, category_id, base_unit, unit_label, unit_value = 1, min_qty = 0 } = req.body;

    if (!name || !base_unit || !unit_label) {
      return res.status(400).json({ msg: "name, base_unit, unit_label are required" });
    }

    const item = await DB.PostgresInsert("stock_items", {
      name,
      category_id:  category_id ? Number(category_id) : null,
      base_unit,
      unit_label,
      unit_value:   Number(unit_value) || 1,
      current_qty:  0,       // always starts at 0 — receive stock via POST /stock/receive
      min_qty:      Number(min_qty) || 0,
      is_active:    true
    });

    res.status(201).json({ success: true, item });

  } catch (err) {
    console.error("Create stock item error:", err);
    res.status(500).json({ msg: err.message });
  }
};


/* ─────────────────────────────────────────────────────────
   UPDATE STOCK ITEM  (Edit button)
   Allowed  : name, category_id, base_unit, unit_label, unit_value, min_qty, is_active
   Blocked  : current_qty  →  use /stock/receive or /stock/adjust
   ───────────────────────────────────────────────────────── */
exports.updateStockItem = async (req, res) => {
  try {
    if (req.body.current_qty !== undefined) {
      return res.status(400).json({
        msg: "current_qty cannot be edited here. Use POST /stock/receive to add stock or POST /stock/adjust for corrections."
      });
    }

    const { name, category_id, base_unit, unit_label, unit_value, min_qty, is_active } = req.body;

    const payload = {};
    if (name        !== undefined) payload.name        = name;
    if (category_id !== undefined) payload.category_id = category_id ? Number(category_id) : null;
    if (base_unit   !== undefined) payload.base_unit   = base_unit;
    if (unit_label  !== undefined) payload.unit_label  = unit_label;
    if (unit_value  !== undefined) payload.unit_value  = Number(unit_value) || 1;
    if (min_qty     !== undefined) payload.min_qty     = Number(min_qty) || 0;
    if (is_active   !== undefined) payload.is_active   = !!is_active;

    if (!Object.keys(payload).length) {
      return res.status(400).json({ msg: "No fields to update" });
    }

    payload.updated_at = new Date();

    const updated = await DB.PostgresUpdate(
      "stock_items",
      payload,
      { id: Number(req.params.id) }
    );

    if (!updated) return res.status(404).json({ msg: "Stock item not found" });

    res.json({ success: true, message: "Stock item updated" });

  } catch (err) {
    console.error("Update stock item error:", err);
    res.status(500).json({ msg: "Update failed" });
  }
};


/* ─────────────────────────────────────────────────────────
   DELETE STOCK ITEM  (soft delete)
   Blocked if item still has active stock (remaining_qty > 0)
   ───────────────────────────────────────────────────────── */
exports.deleteStockItem = async (req, res) => {
  try {
    const id = Number(req.params.id);

    // Block delete if batches still have stock
    const active = await DB.PostgresAny(
      `SELECT COUNT(*) AS cnt FROM stock_batches WHERE stock_item_id = $1 AND remaining_qty > 0`,
      [id]
    );
    if (Number(active[0].cnt) > 0) {
      return res.status(400).json({
        msg: "Cannot delete: item has active stock. Use stock adjust to set to 0 first."
      });
    }

    const updated = await DB.PostgresUpdate(
      "stock_items",
      { is_active: false, updated_at: new Date() },
      { id }
    );
    if (!updated) return res.status(404).json({ msg: "Stock item not found" });

    res.json({ success: true, message: "Stock item deleted" });

  } catch (err) {
    console.error("Delete stock item error:", err);
    res.status(500).json({ msg: "Delete failed" });
  }
};


/* ─────────────────────────────────────────────────────────
   TOGGLE ACTIVE / INACTIVE
   ───────────────────────────────────────────────────────── */
exports.toggleStockItem = async (req, res) => {
  try {
    const id = Number(req.params.id);

    const item = await DB.PostgresAny(
      `SELECT id, is_active FROM stock_items WHERE id = $1`,
      [id]
    );
    if (!item.length) return res.status(404).json({ msg: "Stock item not found" });

    const updated = await DB.PostgresUpdate(
      "stock_items",
      { is_active: !item[0].is_active, updated_at: new Date() },
      { id }
    );

    res.json({
      success:   true,
      is_active: updated.is_active,
      message:   updated.is_active ? "Activated" : "Deactivated"
    });

  } catch (err) {
    console.error("Toggle stock item error:", err);
    res.status(500).json({ msg: "Toggle failed" });
  }
};


/* ─────────────────────────────────────────────────────────
   DROPDOWN  — used by recipe builder & receive-stock form
   ───────────────────────────────────────────────────────── */
exports.getStockItemsDropdown = async (req, res) => {
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
    console.error("Stock items dropdown error:", err);
    res.status(500).json({ msg: "Server error" });
  }
};
