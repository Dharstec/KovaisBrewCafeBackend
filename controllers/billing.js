const DB = require("../middleware/dbFunctions");

/* =========================================================
   CREATE BILL (PENDING) + REDUCE STOCK (DIRECT + RECIPE)
   ========================================================= */
exports.createBill = async (req, res) => {
  const client = await DB.getClient(); // pg client

  try {
    const { items, customer_name, local_id } = req.body;

    if (!Array.isArray(items) || !items.length) {
      return res.status(400).json({
        code: "INVALID_ITEMS",
        message: "Items array required"
      });
    }

    // ── Idempotency: if same local_id already exists, return existing bill ──
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

    /* ===============================
       1️⃣ PRE-VALIDATE STOCK (NO DB CHANGE)
       =============================== */
    for (const i of items) {
      if (!i.productId || !i.name || !i.price || !i.qty) {
        throw {
          code: "INVALID_ITEM_DATA",
          message: "Invalid item data",
          product: i.name
        };
      }

      /* DIRECT STOCK */
      const product = await client.query(
        `SELECT track_stock, current_qty
         FROM products
         WHERE id = $1`,
        [i.productId]
      );

      if (product.rows.length && product.rows[0].track_stock) {
        if (product.rows[0].current_qty < i.qty) {
          throw {
            code: "INSUFFICIENT_STOCK",
            product: i.name,
            required: i.qty,
            available: product.rows[0].current_qty
          };
        }
      }

      /* RECIPE STOCK */
      const recipes = await client.query(
        `SELECT raw_product_id, used_qty
         FROM product_recipes
         WHERE sale_product_id = $1`,
        [i.productId]
      );

      for (const r of recipes.rows) {
        const totalUsed = r.used_qty * i.qty;

        const raw = await client.query(
          `SELECT current_qty, name
           FROM products
           WHERE id = $1
             AND track_stock = true`,
          [r.raw_product_id]
        );

        if (!raw.rows.length || raw.rows[0].current_qty < totalUsed) {
          throw {
            code: "INSUFFICIENT_RAW_STOCK",
            product: i.name,
            raw_material: raw.rows[0]?.name || "Unknown",
            required: totalUsed,
            available: raw.rows[0]?.current_qty || 0
          };
        }
      }
    }

    /* ===============================
       2️⃣ CREATE BILL (SAFE NOW)
       =============================== */
    const billRes = await client.query(
      `INSERT INTO bills (customer_name, status, grand_total, local_id)
       VALUES ($1, 'PENDING', 0, $2)
       RETURNING id`,
      [customer_name, local_id || null]
    );

    const billId = billRes.rows[0].id;
    let total = 0;

    /* ===============================
       3️⃣ INSERT ITEMS + DEDUCT STOCK
       =============================== */
    for (const i of items) {
      await client.query(
        `INSERT INTO bill_items
         (bill_id, product_id, product_name, price, qty)
         VALUES ($1,$2,$3,$4,$5)`,
        [billId, i.productId, i.name, i.price, i.qty]
      );

      total += i.price * i.qty;

      /* DIRECT STOCK */
      const product = await client.query(
        `SELECT track_stock, current_qty
         FROM products WHERE id=$1`,
        [i.productId]
      );

      if (product.rows.length && product.rows[0].track_stock) {
        await client.query(
          `UPDATE products
           SET current_qty = current_qty - $1
           WHERE id = $2`,
          [i.qty, i.productId]
        );

        await client.query(
          `INSERT INTO stock_logs
           (product_id, change_qty, action, reference_id, note)
           VALUES ($1,$2,'SALE',$3,$4)`,
          [i.productId, -i.qty, billId, `Pending bill #${billId}`]
        );
      }

      /* RECIPE STOCK */
      const recipes = await client.query(
        `SELECT raw_product_id, used_qty
         FROM product_recipes
         WHERE sale_product_id=$1`,
        [i.productId]
      );

      for (const r of recipes.rows) {
        const used = r.used_qty * i.qty;

        await client.query(
          `UPDATE products
           SET current_qty = current_qty - $1
           WHERE id = $2`,
          [used, r.raw_product_id]
        );

        await client.query(
          `INSERT INTO stock_logs
           (product_id, change_qty, action, reference_id, note)
           VALUES ($1,$2,'USAGE',$3,$4)`,
          [
            r.raw_product_id,
            -used,
            billId,
            `Recipe usage for ${i.name}`
          ]
        );
      }
    }

    /* ===============================
       4️⃣ UPDATE BILL TOTAL
       =============================== */
    await client.query(
      `UPDATE bills SET grand_total=$1 WHERE id=$2`,
      [total, billId]
    );

    await client.query("COMMIT");

    res.json({
      bill_id: billId,
      grand_total: total
    });

  } catch (err) {
    await client.query("ROLLBACK");

    console.error("Create bill error:", err);

    res.status(400).json({
      success: false,
      code: err.code || "BILL_FAILED",
      message: err.message || "Bill creation failed",
      details: err
    });

  } finally {
    client.release();
  }
};


/* =========================================================
   UPDATE PENDING BILL (RESTORE + APPLY STOCK)
   ========================================================= */
exports.updateBill = async (req, res) => {
  try {
    const billId = Number(req.params.id);
    const { items, customer_name } = req.body;

    if (!Array.isArray(items) || !items.length) {
      return res.status(400).json({ msg: "Items required" });
    }

    /* 1️⃣ Ensure pending bill */
    const bill = await DB.PostgresAny(
      `SELECT id FROM bills
       WHERE id=$1 AND status='PENDING'`,
      [billId]
    );

    if (!bill.length) {
      return res.status(404).json({ msg: "Pending bill not found" });
    }

    /* 2️⃣ RESTORE DIRECT STOCK */
    const oldItems = await DB.PostgresAny(
      `SELECT bi.product_id, bi.qty, p.track_stock
      FROM bill_items bi
      JOIN products p ON p.id = bi.product_id
      WHERE bi.bill_id = $1`,
      [billId]
    );

    for (const i of oldItems) {
      if (!i.track_stock) continue;

      const prod = await DB.PostgresAny(
        `SELECT current_qty FROM products WHERE id=$1`,
        [i.product_id]
      );

      await DB.PostgresUpdate(
        "products",
        { current_qty: Number(prod[0].current_qty) + Number(i.qty) },
        { id: i.product_id }
      );
    }

    /* 3️⃣ RESTORE RECIPE STOCK */
    const oldRecipes = await DB.PostgresAny(
      `
      SELECT pr.raw_product_id, pr.used_qty, bi.qty
      FROM bill_items bi
      JOIN product_recipes pr
        ON pr.sale_product_id = bi.product_id
      WHERE bi.bill_id = $1
      `,
      [billId]
    );

    for (const r of oldRecipes) {
      const restoreQty =
        Number(r.used_qty) * Number(r.qty);

      const raw = await DB.PostgresAny(
        `SELECT current_qty FROM products WHERE id=$1`,
        [r.raw_product_id]
      );

      await DB.PostgresUpdate(
        "products",
        { current_qty: Number(raw[0].current_qty) + restoreQty },
        { id: r.raw_product_id }
      );
    }

    /* 4️⃣ DELETE OLD ITEMS */
    await DB.PostgresDelete("bill_items", "bill_id", billId);

    let total = 0;

    /* 5️⃣ ADD NEW ITEMS + APPLY STOCK */
    for (const i of items) {

      await DB.PostgresInsert("bill_items", {
        bill_id: billId,
        product_id: i.productId,
        product_name: i.name,
        price: i.price,
        qty: i.qty
      });

      total += Number(i.price) * Number(i.qty);

      /* DIRECT STOCK */
      const product = await DB.PostgresAny(
        `SELECT track_stock, current_qty FROM products WHERE id=$1`,
        [i.productId]
      );

      if (product[0]?.track_stock) {
        const newQty =
          Number(product[0].current_qty) - Number(i.qty);

        if (newQty < 0) {
          return res.status(400).json({
            msg: `Insufficient stock for ${i.name}`
          });
        }

        await DB.PostgresUpdate(
          "products",
          { current_qty: newQty },
          { id: i.productId }
        );
      }

      /* RECIPE STOCK */
      const recipes = await DB.PostgresAny(
        `
        SELECT raw_product_id, used_qty
        FROM product_recipes
        WHERE sale_product_id = $1
        `,
        [i.productId]
      );

      for (const r of recipes) {
        const totalUsed =
          Number(r.used_qty) * Number(i.qty);

        const raw = await DB.PostgresAny(
          `SELECT current_qty FROM products WHERE id=$1`,
          [r.raw_product_id]
        );

        if (raw[0].current_qty < totalUsed) {
          return res.status(400).json({
            msg: "Insufficient raw material stock"
          });
        }

        await DB.PostgresUpdate(
          "products",
          { current_qty: raw[0].current_qty - totalUsed },
          { id: r.raw_product_id }
        );
      }
    }

    /* 6️⃣ UPDATE TOTAL */
    await DB.PostgresUpdate(
      "bills",
      { grand_total: total, customer_name: customer_name },
      { id: billId }
    );

    res.json({
      message: "Bill updated & stock adjusted",
      bill_id: billId,
      grand_total: total
    });

  } catch (err) {
    console.error("Update bill error:", err);
    res.status(500).json({ error: err.message });
  }
};

// exports.completeBill = async (req, res) => {
//   try {
//     await DB.PostgresUpdate(
//       "bills",
//       { status: "COMPLETED" },
//       { id: req.params.id }
//     );

//     res.json({ message: "Bill completed" });

//   } catch (err) {
//     console.error("Complete bill error:", err);
//     res.status(500).json({ error: err.message });
//   }
// };

exports.completedBills = async (req, res) => {
  try {
    const { start_date, end_date, page = 1, limit = 6 } = req.query;

    const pageNo = Number(page);
    const pageSize = Number(limit);
    const offset = (pageNo - 1) * pageSize;

    let where = `WHERE status = 'COMPLETED'`;
    const params = [];

    if (start_date && end_date) {
      params.push(start_date, end_date);
      where += ` AND DATE(created_at) BETWEEN $1 AND $2`;
    }

    /* ---------- BILL LIST ---------- */
    const bills = await DB.PostgresAny(
      `
      SELECT *
      FROM bills
      ${where}
      ORDER BY id DESC
      LIMIT $${params.length + 1}
      OFFSET $${params.length + 2}
      `,
      [...params, pageSize, offset]
    );

    for (const b of bills) {
      b.items = await DB.PostgresAny(
        `
        SELECT
          product_id AS productId,
          product_name AS name,
          price,
          qty
        FROM bill_items
        WHERE bill_id = $1
        `,
        [b.id]
      );
    }

    /* ---------- COUNT ---------- */
    const count = await DB.PostgresAny(
      `SELECT COUNT(*) AS total FROM bills ${where}`,
      params
    );

    /* ---------- PAYMENT SUMMARY ---------- */
    const summary = await DB.PostgresAny(
      `
      SELECT
        SUM(CASE WHEN payment_mode = 'CASH' THEN grand_total ELSE 0 END) AS cash_total,
        SUM(CASE WHEN payment_mode = 'UPI' THEN grand_total ELSE 0 END) AS upi_total,
        SUM(grand_total) AS grand_total
      FROM bills
      ${where}
      `,
      params
    );

    res.json({
      data: bills,
      total: Number(count[0].total),
      totalPages: Math.ceil(Number(count[0].total) / pageSize),
      summary: summary[0]   // 👈 IMPORTANT
    });

  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
};


exports.pendingBills = async (req, res) => {
  try {
    const bills = await DB.PostgresAny(
      "SELECT * FROM bills WHERE status='PENDING' ORDER BY id DESC"
    );

    for (const b of bills) {
      b.items = await DB.PostgresAny(
        `SELECT product_id AS productId,product_name AS name, price, qty
         FROM bill_items WHERE bill_id=$1`,
        [b.id]
      );
    }

    res.json(bills);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

exports.completeBill = async (req, res) => {
  try {
    const billId = req.params.id;
    const { customer_name, payment_mode, grand_total, discount_amount = 0 } = req.body;

    // Idempotent — already completed bills just return success
    const existing = await DB.PostgresAny(
      `SELECT status FROM bills WHERE id = $1`,
      [billId]
    );
    if (existing[0]?.status === 'COMPLETED') {
      return res.json({ message: 'Bill already completed' });
    }

    await DB.PostgresUpdate(
      "bills",
      {
        customer_name,
        payment_mode,
        status: "COMPLETED",
        grand_total: Number(grand_total) || 0,
        discount_amount: Number(discount_amount) || 0
      },
      { id: billId }
    );

    res.json({ message: "Bill completed" });
  } catch (err) {
    console.error("Complete bill error:", err);
    res.status(500).json({ error: err.message });
  }
};


/* =========================================================
   SYNC OFFLINE BILL — create + complete atomically
   local_id guarantees idempotency (no duplicates on retry)
   ========================================================= */
exports.syncOfflineBill = async (req, res) => {
  const client = await DB.getClient();
  try {
    const { items, customer_name, payment_mode, grand_total, discount_amount = 0, local_id } = req.body;

    if (!Array.isArray(items) || !items.length)
      return res.status(400).json({ msg: "Items required" });

    // ── Idempotency check ──
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

    // Insert as COMPLETED directly (offline bill, stock deducted best-effort)
    const billRes = await client.query(
      `INSERT INTO bills (customer_name, status, grand_total, discount_amount, payment_mode, local_id)
       VALUES ($1,'COMPLETED',$2,$3,$4,$5) RETURNING id`,
      [customer_name, Number(grand_total) || 0, Number(discount_amount) || 0, payment_mode, local_id || null]
    );
    const billId = billRes.rows[0].id;

    for (const i of items) {
      await client.query(
        `INSERT INTO bill_items (bill_id, product_id, product_name, price, qty)
         VALUES ($1,$2,$3,$4,$5)`,
        [billId, i.productId, i.name, i.price, i.qty]
      );

      // Best-effort stock deduction (allow negative for offline sync)
      const product = await client.query(
        `SELECT track_stock FROM products WHERE id=$1`, [i.productId]
      );
      if (product.rows[0]?.track_stock) {
        await client.query(
          `UPDATE products SET current_qty = current_qty - $1 WHERE id=$2`,
          [i.qty, i.productId]
        );
      }

      // Recipe stock
      const recipes = await client.query(
        `SELECT raw_product_id, used_qty FROM product_recipes WHERE sale_product_id=$1`,
        [i.productId]
      );
      for (const r of recipes.rows) {
        await client.query(
          `UPDATE products SET current_qty = current_qty - $1 WHERE id=$2`,
          [r.used_qty * i.qty, r.raw_product_id]
        );
      }
    }

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




