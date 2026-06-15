const DB = require("../middleware/dbFunctions");

/* =========================================================
   HELPER — FIFO deduction from stock_entries (per shop)
   ========================================================= */
async function _deductStockItem(client, stockItemId, totalUsed, billId, note, shopId) {
  await client.query(
    `UPDATE stock_items SET current_qty = current_qty - $1, updated_at = NOW() WHERE id = $2 AND shop_id = $3`,
    [totalUsed, stockItemId, shopId]
  );

  const batches = await client.query(
    `SELECT id, remaining_qty FROM stock_entries
     WHERE stock_item_id = $1 AND remaining_qty > 0 AND shop_id = $2
     ORDER BY expiry_date ASC NULLS LAST, purchase_date ASC, created_at ASC`,
    [stockItemId, shopId]
  );

  let remaining = totalUsed;
  for (const batch of batches.rows) {
    if (remaining <= 0) break;
    const deduct = Math.min(remaining, Number(batch.remaining_qty));
    await client.query(
      `UPDATE stock_entries SET remaining_qty = remaining_qty - $1 WHERE id = $2`,
      [deduct, batch.id]
    );
    await client.query(
      `INSERT INTO stock_logs (stock_item_id, stock_entry_id, change_qty, action, reference_id, note, shop_id)
       VALUES ($1, $2, $3, 'USAGE_RESERVED', $4, $5, $6)`,
      [stockItemId, batch.id, -deduct, billId, note, shopId]
    );
    remaining -= deduct;
  }

  if (batches.rows.length === 0) {
    await client.query(
      `INSERT INTO stock_logs (stock_item_id, stock_entry_id, change_qty, action, reference_id, note, shop_id)
       VALUES ($1, NULL, $2, 'USAGE_RESERVED', $3, $4, $5)`,
      [stockItemId, -totalUsed, billId, note, shopId]
    );
  }
}

async function _deductStock(client, items, billId, shopId) {
  for (const i of items) {
    if (!i.productId) continue; // add-on items have no product — skip stock deduction
    const productRow = await client.query(
      `SELECT stock_item_id FROM products WHERE id = $1 AND shop_id = $2`,
      [i.productId, shopId]
    );
    const directItemId = productRow.rows[0]?.stock_item_id;

    if (directItemId) {
      await _deductStockItem(
        client, directItemId, Number(i.qty), billId,
        `Reserved for bill #${billId} — direct stock`, shopId
      );
      continue;
    }

    const recipes = await client.query(
      `SELECT COALESCE(stock_item_id, raw_product_id) AS stock_item_id, used_qty
       FROM product_recipes
       WHERE sale_product_id = $1
         AND COALESCE(stock_item_id, raw_product_id) IS NOT NULL
         AND shop_id = $2`,
      [i.productId, shopId]
    );

    if (recipes.rows.length > 0) {
      for (const r of recipes.rows) {
        const totalUsed = Number(r.used_qty) * Number(i.qty);
        await _deductStockItem(
          client, r.stock_item_id, totalUsed, billId,
          `Reserved for bill #${billId} — ingredient`, shopId
        );
      }
    }
  }
}

/* =========================================================
   HELPER — restore stock on cancel (shop-scoped via bill)
   ========================================================= */
async function _restoreStock(client, billId) {
  const logs = await client.query(
    `SELECT stock_item_id, stock_entry_id, change_qty FROM stock_logs
     WHERE reference_id = $1 AND action = 'USAGE_RESERVED'`,
    [billId]
  );

  if (!logs.rows.length) return;

  const itemMap = {};
  for (const log of logs.rows) {
    const k = String(log.stock_item_id);
    itemMap[k] = (itemMap[k] || 0) + Number(log.change_qty);
  }
  for (const [id, changeQty] of Object.entries(itemMap)) {
    await client.query(
      `UPDATE stock_items SET current_qty = current_qty - $1, updated_at = NOW() WHERE id = $2`,
      [changeQty, id]
    );
  }

  for (const log of logs.rows) {
    if (!log.stock_entry_id) continue;
    await client.query(
      `UPDATE stock_entries SET remaining_qty = remaining_qty - $1 WHERE id = $2`,
      [log.change_qty, log.stock_entry_id]
    );
  }

  await client.query(
    `UPDATE stock_logs SET action = 'RETURN', note = CONCAT('Cancelled — ', note)
     WHERE reference_id = $1 AND action = 'USAGE_RESERVED'`,
    [billId]
  );
}

async function _writeCompletionLogs(client, billId) {
  await client.query(
    `UPDATE stock_logs SET action = 'USAGE', note = REPLACE(note, 'Reserved for', 'Used for')
     WHERE reference_id = $1 AND action = 'USAGE_RESERVED'`,
    [billId]
  );
}

/* =========================================================
   HELPER — validate stock for a list of cart/bill items
   Aggregates qty per product, then collects EVERY shortfall
   (does not short-circuit) so the UI can show the full picture.
   Returns { ok, shortfall: [{ product_id, product_name,
     required, available, unit_label?, type: 'direct'|'recipe',
     ingredients?: [{ stock_item_id, name, required, available, unit_label }]
   }] }.
   ========================================================= */
async function _validateStockForItems(client, items, shopId) {
  const aggregated = new Map();
  for (const it of items || []) {
    const pid = Number(it.productId);
    const qty = Number(it.qty);
    if (!pid || !qty || qty <= 0) continue;
    const prev = aggregated.get(pid);
    aggregated.set(pid, {
      productId: pid,
      name: it.name || prev?.name || `#${pid}`,
      qty: (prev?.qty || 0) + qty
    });
  }

  const shortfall = [];

  for (const i of aggregated.values()) {
    const productRow = await client.query(
      `SELECT stock_item_id FROM products WHERE id = $1 AND shop_id = $2`,
      [i.productId, shopId]
    );
    const directItemId = productRow.rows[0]?.stock_item_id;

    if (directItemId) {
      const stock = await client.query(
        `SELECT current_qty, name, unit_label, base_unit
         FROM stock_items WHERE id = $1 AND is_active = true AND shop_id = $2`,
        [directItemId, shopId]
      );
      const available = Number(stock.rows[0]?.current_qty ?? 0);
      if (!stock.rows.length || available < Number(i.qty)) {
        shortfall.push({
          product_id:   i.productId,
          product_name: i.name,
          type:         'direct',
          required:     Number(i.qty),
          available,
          unit_label:   stock.rows[0]?.unit_label || stock.rows[0]?.base_unit || ''
        });
      }
      continue;
    }

    const recipes = await client.query(
      `SELECT COALESCE(pr.stock_item_id, pr.raw_product_id) AS stock_item_id,
              pr.used_qty,
              si.name        AS stock_item_name,
              si.current_qty AS stock_current_qty,
              si.is_active   AS stock_is_active,
              si.unit_label,
              si.base_unit
         FROM product_recipes pr
         LEFT JOIN stock_items si
                ON si.id = COALESCE(pr.stock_item_id, pr.raw_product_id)
        WHERE pr.sale_product_id = $1
          AND COALESCE(pr.stock_item_id, pr.raw_product_id) IS NOT NULL
          AND pr.shop_id = $2`,
      [i.productId, shopId]
    );

    if (!recipes.rows.length) continue;

    const insufficient = [];
    for (const r of recipes.rows) {
      const totalUsed = Number(r.used_qty) * Number(i.qty);
      // Treat missing or deactivated stock items as zero-available so they
      // surface in the shortfall report (matches the original strict behavior).
      const inactive  = r.stock_is_active === false || r.stock_is_active === null;
      const available = inactive ? 0 : Number(r.stock_current_qty ?? 0);
      if (available < totalUsed) {
        insufficient.push({
          stock_item_id: r.stock_item_id,
          name:          r.stock_item_name || 'Unknown',
          required:      totalUsed,
          available,
          unit_label:    r.unit_label || r.base_unit || ''
        });
      }
    }

    if (insufficient.length) {
      shortfall.push({
        product_id:   i.productId,
        product_name: i.name,
        type:         'recipe',
        required:     Number(i.qty),
        ingredients:  insufficient
      });
    }
  }

  return { ok: shortfall.length === 0, shortfall };
}

/* =========================================================
   PRE-FLIGHT STOCK CHECK
   ========================================================= */
exports.checkStock = async (req, res) => {
  const client = await DB.getClient();
  const shopId = req.shop_id;
  try {
    const { items } = req.body || {};
    if (!Array.isArray(items) || !items.length) {
      return res.json({ ok: true, shortfall: [] });
    }
    const result = await _validateStockForItems(client, items, shopId);
    res.json(result);
  } catch (err) {
    console.error("Check stock error:", err);
    res.status(500).json({ ok: false, message: err.message || "Stock check failed", shortfall: [] });
  } finally {
    client.release();
  }
};

/* =========================================================
   CREATE BILL
   ========================================================= */
exports.createBill = async (req, res) => {
  const client = await DB.getClient();
  const shopId = req.shop_id;

  try {
    const { items, customer_name, local_id, platform, bill_date } = req.body;
    const createdAt = (bill_date && req.role_type === 'Admin') ? bill_date : null;

    if (!Array.isArray(items) || !items.length) {
      return res.status(400).json({ code: "INVALID_ITEMS", message: "Items array required" });
    }

    if (local_id) {
      const existing = await client.query(
        `SELECT id, grand_total FROM bills WHERE local_id = $1 AND shop_id = $2`,
        [local_id, shopId]
      );
      if (existing.rows.length) {
        client.release();
        return res.json({ bill_id: existing.rows[0].id, grand_total: existing.rows[0].grand_total });
      }
    }

    await client.query("BEGIN");

    for (const i of items) {
      const hasProduct = i.productId != null;
      if ((hasProduct && !i.productId) || !i.name || isNaN(Number(i.price)) || Number(i.price) < 0 || !i.qty) {
        throw { code: "INVALID_ITEM_DATA", message: "Invalid item data", product: i.name };
      }
    }

    const billRes = await client.query(
      `INSERT INTO bills (customer_name, status, grand_total, local_id, platform, created_at, shop_id)
       VALUES ($1, 'PENDING', 0, $2, $3, COALESCE($4::timestamptz, NOW()), $5) RETURNING id`,
      [customer_name, local_id || null, platform || null, createdAt || null, shopId]
    );
    const billId = billRes.rows[0].id;
    let total = 0;

    for (const i of items) {
      await client.query(
        `INSERT INTO bill_items (bill_id, product_id, product_name, price, qty, shop_id)
         VALUES ($1,$2,$3,$4,$5,$6)`,
        [billId, i.productId || null, i.name, Number(i.price) || 0, i.qty, shopId]
      );
      total += Number(i.price) * Number(i.qty);
    }

    await client.query(`UPDATE bills SET grand_total = $1 WHERE id = $2`, [total, billId]);

    await client.query("COMMIT");
    res.json({ bill_id: billId, grand_total: total });

  } catch (err) {
    await client.query("ROLLBACK");
    console.error("Create bill error:", err);
    res.status(400).json({
      success: false,
      code:    err.code    || "BILL_FAILED",
      message: err.message || "Bill creation failed",
      details: err
    });
  } finally {
    client.release();
  }
};

/* =========================================================
   UPDATE PENDING BILL
   ========================================================= */
exports.updateBill = async (req, res) => {
  const client = await DB.getClient();
  const shopId = req.shop_id;
  try {
    const billId = Number(req.params.id);
    const { items, customer_name } = req.body;

    if (!Array.isArray(items) || !items.length) {
      return res.status(400).json({ msg: "Items required" });
    }

    await client.query("BEGIN");

    const bill = await client.query(
      `SELECT id FROM bills WHERE id = $1 AND status = 'PENDING' AND shop_id = $2`,
      [billId, shopId]
    );
    if (!bill.rows.length) {
      await client.query("ROLLBACK");
      return res.status(404).json({ msg: "Pending bill not found" });
    }

    await client.query(`DELETE FROM bill_items WHERE bill_id = $1`, [billId]);

    let total = 0;
    for (const i of items) {
      const hasProduct = i.productId != null;
      if ((hasProduct && !i.productId) || !i.name || isNaN(Number(i.price)) || Number(i.price) < 0 || !i.qty) {
        throw { code: "INVALID_ITEM_DATA", message: "Invalid item data", product: i.name };
      }
      await client.query(
        `INSERT INTO bill_items (bill_id, product_id, product_name, price, qty, shop_id)
         VALUES ($1,$2,$3,$4,$5,$6)`,
        [billId, i.productId || null, i.name, Number(i.price) || 0, i.qty, shopId]
      );
      total += Number(i.price) * Number(i.qty);
    }

    await client.query(
      `UPDATE bills SET grand_total = $1, customer_name = $2 WHERE id = $3`,
      [total, customer_name, billId]
    );

    await client.query("COMMIT");
    res.json({ message: "Bill updated", bill_id: billId, grand_total: total });

  } catch (err) {
    await client.query("ROLLBACK");
    console.error("Update bill error:", err);
    res.status(400).json({
      success: false,
      code:    err.code    || "UPDATE_FAILED",
      message: err.message || "Bill update failed",
      details: err
    });
  } finally {
    client.release();
  }
};

/* =========================================================
   COMPLETE BILL
   ========================================================= */
exports.completeBill = async (req, res) => {
  const client = await DB.getClient();
  const shopId = req.shop_id;
  try {
    const billId = req.params.id;
    const { customer_name, payment_mode, grand_total, discount_amount = 0, bill_date, cash_amount, upi_amount } = req.body;
    const createdAt = (bill_date && req.role_type === 'Admin') ? bill_date : null;

    await client.query("BEGIN");

    const existing = await client.query(
      `SELECT status FROM bills WHERE id = $1 AND shop_id = $2`,
      [billId, shopId]
    );
    if (!existing.rows.length) {
      await client.query("ROLLBACK");
      return res.status(404).json({ message: "Bill not found" });
    }
    if (existing.rows[0]?.status === 'COMPLETED') {
      await client.query("ROLLBACK");
      return res.json({ message: "Bill already completed" });
    }

    /* Load bill items for stock validation + deduction */
    const billItemsRes = await client.query(
      `SELECT product_id AS "productId", product_name AS name, price, qty
       FROM bill_items WHERE bill_id = $1`,
      [billId]
    );
    const items = billItemsRes.rows;

    /* Validate stock — collects all shortfalls so the UI can show the full picture */
    const stockCheck = await _validateStockForItems(client, items, shopId);
    if (!stockCheck.ok) {
      throw {
        code:      "INSUFFICIENT_STOCK",
        message:   "One or more items are out of stock",
        shortfall: stockCheck.shortfall
      };
    }

    /* Deduct stock now that bill is confirmed complete */
    await _deductStock(client, items, billId, shopId);

    await client.query(
      `UPDATE bills
       SET customer_name    = $1,
           payment_mode     = $2,
           status           = 'COMPLETED',
           grand_total      = $3,
           discount_amount  = $4,
           cash_amount      = $6,
           upi_amount       = $7,
           created_at       = COALESCE($8::timestamptz, created_at)
       WHERE id = $5`,
      [
        customer_name, payment_mode,
        Number(grand_total) || 0, Number(discount_amount) || 0,
        billId,
        cash_amount != null ? Number(cash_amount) : null,
        upi_amount  != null ? Number(upi_amount)  : null,
        createdAt || null
      ]
    );

    await _writeCompletionLogs(client, billId);

    await client.query("COMMIT");
    res.json({ message: "Bill completed" });

  } catch (err) {
    await client.query("ROLLBACK");
    console.error("Complete bill error:", err);
    res.status(400).json({ success: false, code: err.code || "COMPLETE_FAILED", message: err.message || "Bill completion failed", details: err });
  } finally {
    client.release();
  }
};

/* =========================================================
   CANCEL BILL
   ========================================================= */
exports.cancelBill = async (req, res) => {
  const client = await DB.getClient();
  const shopId = req.shop_id;
  try {
    const billId = req.params.id;

    await client.query("BEGIN");

    const existing = await client.query(
      `SELECT status FROM bills WHERE id = $1 AND shop_id = $2`,
      [billId, shopId]
    );
    if (!existing.rows.length) {
      await client.query("ROLLBACK");
      return res.status(404).json({ message: "Bill not found" });
    }
    if (existing.rows[0].status !== 'PENDING') {
      await client.query("ROLLBACK");
      return res.status(400).json({ message: "Only PENDING bills can be cancelled" });
    }

    await client.query(
      `UPDATE bills SET status = 'CANCELLED' WHERE id = $1`,
      [billId]
    );

    await client.query("COMMIT");
    res.json({ message: "Bill cancelled" });

  } catch (err) {
    await client.query("ROLLBACK");
    console.error("Cancel bill error:", err);
    res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }
};

/* =========================================================
   PENDING BILLS
   ========================================================= */
exports.pendingBills = async (req, res) => {
  try {
    const shopId = req.shop_id;
    const bills = await DB.PostgresAny(
      `SELECT * FROM bills WHERE status = 'PENDING' AND shop_id = $1 ORDER BY id DESC`,
      [shopId]
    );
    for (const b of bills) {
      b.items = await DB.PostgresAny(
        `SELECT product_id AS "productId", product_name AS name, price, qty
         FROM bill_items WHERE bill_id = $1`,
        [b.id]
      );
    }
    res.json(bills);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

/* =========================================================
   COMPLETED BILLS
   ========================================================= */
exports.completedBills = async (req, res) => {
  try {
    const shopId = req.shop_id;
    const { start_date, end_date, page = 1, limit = 20, platform } = req.query;

    const pageNo   = Number(page);
    const pageSize = Number(limit);
    const offset   = (pageNo - 1) * pageSize;

    const params = [shopId];
    let where = `WHERE status = 'COMPLETED' AND shop_id = $1`;

    if (start_date && end_date) {
      params.push(start_date, end_date);
      where += ` AND DATE(created_at) BETWEEN $${params.length - 1} AND $${params.length}`;
    }

    if (platform === 'regular') {
      where += ` AND (platform IS NULL OR platform = '')`;
    } else if (platform === 'zomato' || platform === 'swiggy') {
      params.push(platform);
      where += ` AND platform = $${params.length}`;
    }

    const bills = await DB.PostgresAny(
      `SELECT * FROM bills ${where}
       ORDER BY id DESC
       LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
      [...params, pageSize, offset]
    );

    for (const b of bills) {
      b.items = await DB.PostgresAny(
        `SELECT product_id AS "productId", product_name AS name, price, qty
         FROM bill_items WHERE bill_id = $1`,
        [b.id]
      );
    }

    const count = await DB.PostgresAny(
      `SELECT COUNT(*) AS total FROM bills ${where}`,
      params
    );

    const summary = await DB.PostgresAny(
      `SELECT
         SUM(CASE WHEN payment_mode = 'CASH'  THEN grand_total
                  WHEN payment_mode = 'SPLIT' THEN COALESCE(cash_amount, 0)
                  ELSE 0 END) AS cash_total,
         SUM(CASE WHEN payment_mode = 'UPI'   THEN grand_total
                  WHEN payment_mode = 'SPLIT' THEN COALESCE(upi_amount, 0)
                  ELSE 0 END) AS upi_total,
         SUM(CASE WHEN platform = 'zomato'    THEN grand_total ELSE 0 END) AS zomato_total,
         SUM(CASE WHEN platform = 'swiggy'    THEN grand_total ELSE 0 END) AS swiggy_total,
         SUM(grand_total) AS grand_total
       FROM bills ${where}`,
      params
    );

    res.json({
      data:       bills,
      total:      Number(count[0].total),
      totalPages: Math.ceil(Number(count[0].total) / pageSize),
      summary:    summary[0]
    });

  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
};

async function _restoreCompletedStock(client, billId) {
  const logs = await client.query(
    `SELECT stock_item_id, stock_entry_id, change_qty FROM stock_logs
     WHERE reference_id = $1 AND action = 'USAGE'`,
    [billId]
  );
  if (!logs.rows.length) return;

  const itemMap = {};
  for (const log of logs.rows) {
    const k = String(log.stock_item_id);
    itemMap[k] = (itemMap[k] || 0) + Number(log.change_qty);
  }
  for (const [id, changeQty] of Object.entries(itemMap)) {
    await client.query(
      `UPDATE stock_items SET current_qty = current_qty - $1, updated_at = NOW() WHERE id = $2`,
      [changeQty, id]
    );
  }

  for (const log of logs.rows) {
    if (!log.stock_entry_id) continue;
    await client.query(
      `UPDATE stock_entries SET remaining_qty = remaining_qty - $1 WHERE id = $2`,
      [log.change_qty, log.stock_entry_id]
    );
  }

  await client.query(
    `DELETE FROM stock_logs WHERE reference_id = $1 AND action = 'USAGE'`,
    [billId]
  );
}

/* =========================================================
   EDIT COMPLETED BILL
   ========================================================= */
exports.editCompletedBill = async (req, res) => {
  if (req.role_type !== 'Admin') {
    return res.status(403).json({ msg: 'Admin access required' });
  }

  const client = await DB.getClient();
  const shopId = req.shop_id;
  try {
    const billId = Number(req.params.id);
    const { items, customer_name } = req.body;

    if (!Array.isArray(items) || !items.length) {
      return res.status(400).json({ msg: 'Items required' });
    }

    await client.query('BEGIN');

    const bill = await client.query(
      `SELECT id, platform FROM bills WHERE id = $1 AND status = 'COMPLETED' AND shop_id = $2`,
      [billId, shopId]
    );
    if (!bill.rows.length) {
      await client.query('ROLLBACK');
      return res.status(404).json({ msg: 'Completed bill not found' });
    }

    await _restoreCompletedStock(client, billId);

    await client.query(`DELETE FROM bill_items WHERE bill_id = $1`, [billId]);

    let total = 0;
    for (const i of items) {
      const hasProduct = i.productId != null;
      if ((hasProduct && !i.productId) || !i.name || isNaN(Number(i.price)) || Number(i.price) < 0 || !i.qty) {
        throw { code: 'INVALID_ITEM_DATA', message: `Invalid item: ${i.name}` };
      }
      await client.query(
        `INSERT INTO bill_items (bill_id, product_id, product_name, price, qty, shop_id)
         VALUES ($1,$2,$3,$4,$5,$6)`,
        [billId, i.productId || null, i.name, Number(i.price) || 0, i.qty, shopId]
      );
      total += Number(i.price) * Number(i.qty);
    }

    await _deductStock(client, items, billId, shopId);

    await _writeCompletionLogs(client, billId);

    await client.query(
      `UPDATE bills SET grand_total = $1, customer_name = $2 WHERE id = $3`,
      [total, customer_name || null, billId]
    );

    await client.query('COMMIT');
    res.json({ message: 'Bill updated', bill_id: billId, grand_total: total });

  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Edit completed bill error:', err);
    res.status(400).json({
      success: false,
      code:    err.code    || 'EDIT_FAILED',
      message: err.message || 'Bill edit failed',
      details: err
    });
  } finally {
    client.release();
  }
};

/* =========================================================
   DELETE COMPLETED BILL
   ========================================================= */
exports.deleteCompletedBill = async (req, res) => {
  if (req.role_type !== 'Admin') {
    return res.status(403).json({ msg: 'Admin access required' });
  }

  const client = await DB.getClient();
  const shopId = req.shop_id;
  try {
    const billId = Number(req.params.id);

    await client.query('BEGIN');

    const bill = await client.query(
      `SELECT id FROM bills WHERE id = $1 AND status = 'COMPLETED' AND shop_id = $2`,
      [billId, shopId]
    );
    if (!bill.rows.length) {
      await client.query('ROLLBACK');
      return res.status(404).json({ msg: 'Completed bill not found' });
    }

    await _restoreCompletedStock(client, billId);

    await client.query(`DELETE FROM bill_items WHERE bill_id = $1`, [billId]);
    await client.query(`DELETE FROM stock_logs  WHERE reference_id = $1`, [billId]);
    await client.query(`DELETE FROM bills        WHERE id = $1`, [billId]);

    await client.query('COMMIT');
    res.json({ message: 'Bill deleted and stock restored', bill_id: billId });

  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Delete completed bill error:', err);
    res.status(500).json({ msg: err.message || 'Delete failed' });
  } finally {
    client.release();
  }
};

/* =========================================================
   SYNC OFFLINE BILL
   ========================================================= */
exports.syncOfflineBill = async (req, res) => {
  const client = await DB.getClient();
  const shopId = req.shop_id;
  try {
    const {
      items, customer_name, payment_mode,
      grand_total, discount_amount = 0, local_id, platform, bill_date,
      cash_amount, upi_amount
    } = req.body;
    const createdAt = (bill_date && req.role_type === 'Admin') ? bill_date : null;

    if (!Array.isArray(items) || !items.length) {
      return res.status(400).json({ msg: "Items required" });
    }

    if (local_id) {
      const existing = await client.query(
        `SELECT id FROM bills WHERE local_id = $1 AND shop_id = $2`,
        [local_id, shopId]
      );
      if (existing.rows.length) {
        client.release();
        return res.json({ bill_id: existing.rows[0].id, synced: true });
      }
    }

    await client.query("BEGIN");

    const billRes = await client.query(
      `INSERT INTO bills (customer_name, status, grand_total, discount_amount, payment_mode, cash_amount, upi_amount, local_id, platform, created_at, shop_id)
       VALUES ($1,'COMPLETED',$2,$3,$4,$5,$6,$7,$8,COALESCE($9::timestamptz, NOW()),$10) RETURNING id`,
      [
        customer_name,
        Number(grand_total) || 0,
        Number(discount_amount) || 0,
        payment_mode,
        cash_amount != null ? Number(cash_amount) : null,
        upi_amount  != null ? Number(upi_amount)  : null,
        local_id || null,
        platform || null,
        createdAt || null,
        shopId
      ]
    );
    const billId = billRes.rows[0].id;

    for (const i of items) {
      await client.query(
        `INSERT INTO bill_items (bill_id, product_id, product_name, price, qty, shop_id)
         VALUES ($1,$2,$3,$4,$5,$6)`,
        [billId, i.productId || null, i.name, Number(i.price) || 0, i.qty, shopId]
      );
    }

    await _deductStock(client, items, billId, shopId);

    await _writeCompletionLogs(client, billId);

    await client.query("COMMIT");
    res.json({ bill_id: billId, synced: true });

  } catch (err) {
    await client.query("ROLLBACK");
    console.error("Sync offline bill error:", err);
    res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }
};
