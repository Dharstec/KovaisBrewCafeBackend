const DB = require("../middleware/dbFunctions");

/* =========================================================
   HELPER — FIFO deduction from stock_entries
   Consumes nearest-expiry batches first (oldest expiry → oldest purchase).
   Writes USAGE_RESERVED logs per entry for reversibility on cancel.
   Also updates stock_items.current_qty.
   ========================================================= */
async function _deductStockItem(client, stockItemId, totalUsed, billId, note) {
  /* Deduct from stock_items.current_qty */
  await client.query(
    `UPDATE stock_items SET current_qty = current_qty - $1, updated_at = NOW() WHERE id = $2`,
    [totalUsed, stockItemId]
  );

  /* FIFO deduction from stock_entries */
  const batches = await client.query(
    `SELECT id, remaining_qty FROM stock_entries
     WHERE stock_item_id = $1 AND remaining_qty > 0
     ORDER BY expiry_date ASC NULLS LAST, purchase_date ASC, created_at ASC`,
    [stockItemId]
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
      `INSERT INTO stock_logs (stock_item_id, stock_entry_id, change_qty, action, reference_id, note)
       VALUES ($1, $2, $3, 'USAGE_RESERVED', $4, $5)`,
      [stockItemId, batch.id, -deduct, billId, note]
    );
    remaining -= deduct;
  }

  /* No entries: log against item only (stock_entry_id = NULL) */
  if (batches.rows.length === 0) {
    await client.query(
      `INSERT INTO stock_logs (stock_item_id, stock_entry_id, change_qty, action, reference_id, note)
       VALUES ($1, NULL, $2, 'USAGE_RESERVED', $3, $4)`,
      [stockItemId, -totalUsed, billId, note]
    );
  }
}

async function _deductStock(client, items, billId) {
  for (const i of items) {
    /* 1. Direct stock link — buy-and-sell products (Coke, packets, etc.) */
    const productRow = await client.query(
      `SELECT stock_item_id FROM products WHERE id = $1`,
      [i.productId]
    );
    const directItemId = productRow.rows[0]?.stock_item_id;

    if (directItemId) {
      await _deductStockItem(
        client, directItemId, Number(i.qty), billId,
        `Reserved for bill #${billId} — direct stock`
      );
      continue;
    }

    /* 2. Recipe-based — made-to-order products (Latte, food, etc.) */
    const recipes = await client.query(
      `SELECT COALESCE(stock_item_id, raw_product_id) AS stock_item_id, used_qty
       FROM product_recipes
       WHERE sale_product_id = $1
         AND COALESCE(stock_item_id, raw_product_id) IS NOT NULL`,
      [i.productId]
    );

    if (recipes.rows.length > 0) {
      for (const r of recipes.rows) {
        const totalUsed = Number(r.used_qty) * Number(i.qty);
        await _deductStockItem(
          client, r.stock_item_id, totalUsed, billId,
          `Reserved for bill #${billId} — ingredient`
        );
      }
    }
    /* 3. No link and no recipe → no stock deduction (services / untracked items) */
  }
}

/* =========================================================
   HELPER — restore stock on cancel
   Reverses both stock_items.current_qty and
   stock_entries.remaining_qty using the USAGE_RESERVED logs.
   ========================================================= */
async function _restoreStock(client, billId) {
  /* Read all USAGE_RESERVED logs — covers both recipe and direct-stock items */
  const logs = await client.query(
    `SELECT stock_item_id, stock_entry_id, change_qty FROM stock_logs
     WHERE reference_id = $1 AND action = 'USAGE_RESERVED'`,
    [billId]
  );

  if (!logs.rows.length) return;

  /* Restore stock_items.current_qty — group by stock_item_id */
  const itemMap = {};
  for (const log of logs.rows) {
    const k = String(log.stock_item_id);
    itemMap[k] = (itemMap[k] || 0) + Number(log.change_qty); // negative
  }
  for (const [id, changeQty] of Object.entries(itemMap)) {
    /* change_qty is negative, subtract it → adds back */
    await client.query(
      `UPDATE stock_items SET current_qty = current_qty - $1, updated_at = NOW() WHERE id = $2`,
      [changeQty, id]
    );
  }

  /* Restore stock_entries.remaining_qty */
  for (const log of logs.rows) {
    if (!log.stock_entry_id) continue;
    await client.query(
      `UPDATE stock_entries SET remaining_qty = remaining_qty - $1 WHERE id = $2`,
      [log.change_qty, log.stock_entry_id]
    );
  }

  /* Promote USAGE_RESERVED → RETURN */
  await client.query(
    `UPDATE stock_logs SET action = 'RETURN', note = CONCAT('Cancelled — ', note)
     WHERE reference_id = $1 AND action = 'USAGE_RESERVED'`,
    [billId]
  );
}

/* =========================================================
   HELPER — finalise logs when bill completes
   Promotes USAGE_RESERVED → USAGE (already written at create time).
   No new entry needed — just flip the action.
   ========================================================= */
async function _writeCompletionLogs(client, billId) {
  await client.query(
    `UPDATE stock_logs SET action = 'USAGE', note = REPLACE(note, 'Reserved for', 'Used for')
     WHERE reference_id = $1 AND action = 'USAGE_RESERVED'`,
    [billId]
  );
}

/* =========================================================
   CREATE BILL (PENDING) + RESERVE STOCK
   Stock is deducted immediately to prevent double-selling.
   Stock_logs are written only when the bill is COMPLETED.
   ========================================================= */
exports.createBill = async (req, res) => {
  const client = await DB.getClient();

  try {
    const { items, customer_name, local_id, platform } = req.body;

    if (!Array.isArray(items) || !items.length) {
      return res.status(400).json({ code: "INVALID_ITEMS", message: "Items array required" });
    }

    /* Idempotency: same local_id → return existing bill */
    if (local_id) {
      const existing = await client.query(
        `SELECT id, grand_total FROM bills WHERE local_id = $1`,
        [local_id]
      );
      if (existing.rows.length) {
        client.release();
        return res.json({ bill_id: existing.rows[0].id, grand_total: existing.rows[0].grand_total });
      }
    }

    await client.query("BEGIN");

    /* 1️⃣  PRE-VALIDATE STOCK — no DB changes yet */
    for (const i of items) {
      if (!i.productId || !i.name || !i.price || !i.qty) {
        throw { code: "INVALID_ITEM_DATA", message: "Invalid item data", product: i.name };
      }

      /* Check direct stock link first */
      const productRow = await client.query(
        `SELECT stock_item_id FROM products WHERE id = $1`,
        [i.productId]
      );
      const directItemId = productRow.rows[0]?.stock_item_id;

      if (directItemId) {
        const stock = await client.query(
          `SELECT current_qty, name FROM stock_items WHERE id = $1 AND is_active = true`,
          [directItemId]
        );
        if (!stock.rows.length || stock.rows[0].current_qty < i.qty) {
          throw {
            code:      "INSUFFICIENT_STOCK",
            product:   i.name,
            required:  i.qty,
            available: stock.rows[0]?.current_qty || 0
          };
        }
        continue;
      }

      /* Recipe-based stock check */
      const recipes = await client.query(
        `SELECT COALESCE(stock_item_id, raw_product_id) AS stock_item_id, used_qty
         FROM product_recipes
         WHERE sale_product_id = $1
           AND COALESCE(stock_item_id, raw_product_id) IS NOT NULL`,
        [i.productId]
      );
      for (const r of recipes.rows) {
        const totalUsed = r.used_qty * i.qty;
        const raw = await client.query(
          `SELECT current_qty, name FROM stock_items WHERE id = $1 AND is_active = true`,
          [r.stock_item_id]
        );
        if (!raw.rows.length || raw.rows[0].current_qty < totalUsed) {
          throw {
            code:         "INSUFFICIENT_RAW_STOCK",
            product:      i.name,
            raw_material: raw.rows[0]?.name || "Unknown",
            required:     totalUsed,
            available:    raw.rows[0]?.current_qty || 0
          };
        }
      }
    }

    /* 2️⃣  CREATE BILL */
    const billRes = await client.query(
      `INSERT INTO bills (customer_name, status, grand_total, local_id, platform)
       VALUES ($1, 'PENDING', 0, $2, $3) RETURNING id`,
      [customer_name, local_id || null, platform || null]
    );
    const billId = billRes.rows[0].id;
    let total = 0;

    /* 3️⃣  INSERT ITEMS + DEDUCT STOCK (no logs yet — written at complete) */
    for (const i of items) {
      await client.query(
        `INSERT INTO bill_items (bill_id, product_id, product_name, price, qty)
         VALUES ($1,$2,$3,$4,$5)`,
        [billId, i.productId, i.name, i.price, i.qty]
      );
      total += i.price * i.qty;
    }

    await _deductStock(client, items, billId);

    /* 4️⃣  UPDATE TOTAL */
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
   UPDATE PENDING BILL  (restore → re-validate → re-apply)
   Wrapped in a transaction so a partial failure rolls back.
   Stock_logs still written only at completeBill.
   ========================================================= */
exports.updateBill = async (req, res) => {
  const client = await DB.getClient();
  try {
    const billId = Number(req.params.id);
    const { items, customer_name } = req.body;

    if (!Array.isArray(items) || !items.length) {
      return res.status(400).json({ msg: "Items required" });
    }

    await client.query("BEGIN");

    /* 1️⃣  Ensure PENDING */
    const bill = await client.query(
      `SELECT id FROM bills WHERE id = $1 AND status = 'PENDING'`,
      [billId]
    );
    if (!bill.rows.length) {
      await client.query("ROLLBACK");
      return res.status(404).json({ msg: "Pending bill not found" });
    }

    /* 2️⃣  RESTORE STOCK for existing items */
    await _restoreStock(client, billId);

    /* 3️⃣  DELETE OLD ITEMS */
    await client.query(`DELETE FROM bill_items WHERE bill_id = $1`, [billId]);

    /* 4️⃣  PRE-VALIDATE new items */
    for (const i of items) {
      if (!i.productId || !i.name || !i.price || !i.qty) {
        throw { code: "INVALID_ITEM_DATA", message: "Invalid item data", product: i.name };
      }

      const productRow = await client.query(
        `SELECT stock_item_id FROM products WHERE id = $1`,
        [i.productId]
      );
      const directItemId = productRow.rows[0]?.stock_item_id;

      if (directItemId) {
        const stock = await client.query(
          `SELECT current_qty, name FROM stock_items WHERE id = $1 AND is_active = true`,
          [directItemId]
        );
        if (!stock.rows.length || stock.rows[0].current_qty < i.qty) {
          throw {
            code:      "INSUFFICIENT_STOCK",
            product:   i.name,
            required:  i.qty,
            available: stock.rows[0]?.current_qty || 0
          };
        }
        continue;
      }

      const recipes = await client.query(
        `SELECT COALESCE(stock_item_id, raw_product_id) AS stock_item_id, used_qty
         FROM product_recipes
         WHERE sale_product_id = $1
           AND COALESCE(stock_item_id, raw_product_id) IS NOT NULL`,
        [i.productId]
      );
      for (const r of recipes.rows) {
        const totalUsed = r.used_qty * i.qty;
        const raw = await client.query(
          `SELECT current_qty, name FROM stock_items WHERE id = $1 AND is_active = true`,
          [r.stock_item_id]
        );
        if (!raw.rows.length || raw.rows[0].current_qty < totalUsed) {
          throw {
            code:         "INSUFFICIENT_RAW_STOCK",
            product:      i.name,
            raw_material: raw.rows[0]?.name || "Unknown",
            required:     totalUsed,
            available:    raw.rows[0]?.current_qty || 0
          };
        }
      }
    }

    /* 5️⃣  INSERT NEW ITEMS + DEDUCT STOCK */
    let total = 0;
    for (const i of items) {
      await client.query(
        `INSERT INTO bill_items (bill_id, product_id, product_name, price, qty)
         VALUES ($1,$2,$3,$4,$5)`,
        [billId, i.productId, i.name, i.price, i.qty]
      );
      total += Number(i.price) * Number(i.qty);
    }

    await _deductStock(client, items, billId);

    /* 6️⃣  UPDATE TOTAL */
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
   COMPLETE BILL  (PENDING → COMPLETED + write stock_logs)
   Stock was already deducted at createBill.
   Here we only record the audit logs.
   ========================================================= */
exports.completeBill = async (req, res) => {
  const client = await DB.getClient();
  try {
    const billId = req.params.id;
    const { customer_name, payment_mode, grand_total, discount_amount = 0 } = req.body;

    await client.query("BEGIN");

    const existing = await client.query(
      `SELECT status FROM bills WHERE id = $1`,
      [billId]
    );
    /* Idempotent: already completed → return success without double-logging */
    if (existing.rows[0]?.status === 'COMPLETED') {
      await client.query("ROLLBACK");
      return res.json({ message: "Bill already completed" });
    }

    await client.query(
      `UPDATE bills
       SET customer_name    = $1,
           payment_mode     = $2,
           status           = 'COMPLETED',
           grand_total      = $3,
           discount_amount  = $4
       WHERE id = $5`,
      [customer_name, payment_mode, Number(grand_total) || 0, Number(discount_amount) || 0, billId]
    );

    /* Write SALE / USAGE logs now that the sale is confirmed */
    await _writeCompletionLogs(client, billId);

    await client.query("COMMIT");
    res.json({ message: "Bill completed" });

  } catch (err) {
    await client.query("ROLLBACK");
    console.error("Complete bill error:", err);
    res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }
};

/* =========================================================
   CANCEL BILL  (PENDING → CANCELLED + restore stock)
   ========================================================= */
exports.cancelBill = async (req, res) => {
  const client = await DB.getClient();
  try {
    const billId = req.params.id;

    await client.query("BEGIN");

    const existing = await client.query(
      `SELECT status FROM bills WHERE id = $1`,
      [billId]
    );
    if (!existing.rows.length) {
      await client.query("ROLLBACK");
      return res.status(404).json({ message: "Bill not found" });
    }
    if (existing.rows[0].status !== 'PENDING') {
      await client.query("ROLLBACK");
      return res.status(400).json({ message: "Only PENDING bills can be cancelled" });
    }

    /* Restore stock_items + stock_entries, promote logs USAGE_RESERVED → RETURN */
    await _restoreStock(client, billId);

    await client.query(
      `UPDATE bills SET status = 'CANCELLED' WHERE id = $1`,
      [billId]
    );

    await client.query("COMMIT");
    res.json({ message: "Bill cancelled and stock restored" });

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
    const bills = await DB.PostgresAny(
      `SELECT * FROM bills WHERE status = 'PENDING' ORDER BY id DESC`
    );
    for (const b of bills) {
      b.items = await DB.PostgresAny(
        `SELECT product_id AS productId, product_name AS name, price, qty
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
   COMPLETED BILLS  (paginated + payment summary)
   ========================================================= */
exports.completedBills = async (req, res) => {
  try {
    const { start_date, end_date, page = 1, limit = 20, platform } = req.query;

    const pageNo   = Number(page);
    const pageSize = Number(limit);
    const offset   = (pageNo - 1) * pageSize;

    let where  = `WHERE status = 'COMPLETED'`;
    const params = [];

    if (start_date && end_date) {
      params.push(start_date, end_date);
      where += ` AND DATE(created_at) BETWEEN $1 AND $2`;
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
        `SELECT product_id AS productId, product_name AS name, price, qty
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
         SUM(CASE WHEN payment_mode = 'CASH' THEN grand_total ELSE 0 END) AS cash_total,
         SUM(CASE WHEN payment_mode = 'UPI'  THEN grand_total ELSE 0 END) AS upi_total,
         SUM(CASE WHEN platform = 'zomato'   THEN grand_total ELSE 0 END) AS zomato_total,
         SUM(CASE WHEN platform = 'swiggy'   THEN grand_total ELSE 0 END) AS swiggy_total,
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

/* =========================================================
   SYNC OFFLINE BILL — create + complete atomically
   local_id guarantees idempotency on retry
   ========================================================= */
exports.syncOfflineBill = async (req, res) => {
  const client = await DB.getClient();
  try {
    const {
      items, customer_name, payment_mode,
      grand_total, discount_amount = 0, local_id, platform
    } = req.body;

    if (!Array.isArray(items) || !items.length) {
      return res.status(400).json({ msg: "Items required" });
    }

    /* Idempotency */
    if (local_id) {
      const existing = await client.query(
        `SELECT id FROM bills WHERE local_id = $1`,
        [local_id]
      );
      if (existing.rows.length) {
        client.release();
        return res.json({ bill_id: existing.rows[0].id, synced: true });
      }
    }

    await client.query("BEGIN");

    /* Insert as COMPLETED directly */
    const billRes = await client.query(
      `INSERT INTO bills (customer_name, status, grand_total, discount_amount, payment_mode, local_id, platform)
       VALUES ($1,'COMPLETED',$2,$3,$4,$5,$6) RETURNING id`,
      [
        customer_name,
        Number(grand_total) || 0,
        Number(discount_amount) || 0,
        payment_mode,
        local_id || null,
        platform || null
      ]
    );
    const billId = billRes.rows[0].id;

    /* Insert items */
    for (const i of items) {
      await client.query(
        `INSERT INTO bill_items (bill_id, product_id, product_name, price, qty)
         VALUES ($1,$2,$3,$4,$5)`,
        [billId, i.productId, i.name, i.price, i.qty]
      );
    }

    /* Deduct stock via stock_items (best-effort for offline; allow negative) */
    await _deductStock(client, items, billId);

    /* Write stock_logs (bill is already COMPLETED) */
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
