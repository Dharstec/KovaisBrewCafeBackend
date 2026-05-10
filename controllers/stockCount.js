const DB = require("../middleware/dbFunctions");

/* =========================================================
   DAILY NIGHT STOCK COUNT
   - Cashier: GET today's items, POST closing counts
   - Admin: view history, edit/unlock past counts
   ========================================================= */

/* GET /stock-count/today?date=YYYY-MM-DD
   Excel-style grid: Item | Min | Opening | Purchase | Closing
   - Opening = previous day's closing (or current_qty if no prior count)
   - Purchase = SUM of stock_entries for that date
   - Closing = cashier-entered count for that date (if any) */
exports.getTodayCount = async (req, res) => {
  try {
    const shopId = req.shop_id;
    const date = (req.query.date && /^\d{4}-\d{2}-\d{2}$/.test(req.query.date))
      ? req.query.date
      : new Date().toISOString().slice(0, 10);

    const items = await DB.PostgresAny(`
      SELECT
        si.id            AS stock_item_id,
        si.name,
        COALESCE(c.name, 'OTHERS') AS category_name,
        si.category_id,
        si.base_unit,
        si.unit_label,
        si.unit_value,
        ROUND(si.min_qty, 2) AS min_qty,
        CASE
          WHEN si.min_qty IS NULL OR si.min_qty = 0 THEN ''
          ELSE CONCAT(ROUND(si.min_qty, 0), ' ', COALESCE(si.unit_label, si.base_unit))
        END AS min_display,
        ROUND(si.current_qty, 2) AS system_qty,
        ROUND(COALESCE(prev.closing_qty, si.current_qty), 2) AS opening_qty,
        ROUND(COALESCE(pur.purchased, 0), 2) AS purchase_qty,
        ROUND(COALESCE(billed.billed_qty, 0), 2) AS billed_qty,
        ROUND(
          COALESCE(prev.closing_qty, si.current_qty)
          + COALESCE(pur.purchased, 0)
          - COALESCE(billed.billed_qty, 0),
        2) AS expected_closing,
        sc.id            AS count_id,
        sc.closing_qty,
        sc.variance,
        sc.locked,
        sc.note,
        sc.created_at    AS counted_at
      FROM stock_items si
      LEFT JOIN categories c ON c.id = si.category_id
      LEFT JOIN LATERAL (
        SELECT closing_qty FROM stock_counts
        WHERE stock_item_id = si.id AND shop_id = $1 AND count_date < $2::date
        ORDER BY count_date DESC LIMIT 1
      ) prev ON true
      LEFT JOIN LATERAL (
        SELECT COALESCE(SUM(qty), 0) AS purchased
        FROM stock_entries
        WHERE stock_item_id = si.id AND shop_id = $1 AND purchase_date = $2::date
      ) pur ON true
      LEFT JOIN LATERAL (
        SELECT COALESCE(SUM(qty_used), 0) AS billed_qty
        FROM (
          SELECT CAST(bi.qty * COALESCE(pr.used_qty, 1) AS numeric) AS qty_used
          FROM bill_items bi
          JOIN bills b ON b.id = bi.bill_id
          JOIN product_recipes pr
            ON pr.sale_product_id = bi.product_id
           AND COALESCE(pr.stock_item_id, pr.raw_product_id) = si.id
          WHERE b.shop_id = $1
            AND DATE(b.created_at AT TIME ZONE 'Asia/Kolkata') = $2::date
            AND b.status = 'COMPLETED'
          UNION ALL
          SELECT CAST(bi.qty AS numeric) AS qty_used
          FROM bill_items bi
          JOIN bills b ON b.id = bi.bill_id
          JOIN products p ON p.id = bi.product_id
                          AND p.stock_item_id = si.id
                          AND p.shop_id = $1
          WHERE b.shop_id = $1
            AND DATE(b.created_at AT TIME ZONE 'Asia/Kolkata') = $2::date
            AND b.status = 'COMPLETED'
        ) combined
      ) billed ON true
      LEFT JOIN stock_counts sc
        ON sc.stock_item_id = si.id
       AND sc.shop_id       = $1
       AND sc.count_date    = $2::date
      WHERE si.is_active = true AND si.shop_id = $1
      ORDER BY category_name, si.name
    `, [shopId, date]);

    // All categories of the shop (so empty ones still show "+ Add" button)
    const allCats = await DB.PostgresAny(
      `SELECT id, name FROM categories WHERE status = true AND shop_id = $1 ORDER BY name`,
      [shopId]
    );

    const grouped = {};
    const idByName = {};
    for (const c of allCats) {
      grouped[c.name] = [];
      idByName[c.name] = c.id;
    }
    grouped['OTHERS'] = grouped['OTHERS'] || [];

    for (const it of items) {
      const cat = it.category_name || 'OTHERS';
      if (!grouped[cat]) grouped[cat] = [];
      grouped[cat].push(it);
    }

    const groups = Object.keys(grouped)
      .sort()
      .map(name => ({ name, category_id: idByName[name] || null, items: grouped[name] }));

    const anyLocked = items.some(i => i.count_id && i.locked);
    const allFilled = items.length > 0 && items.every(i => i.count_id != null);

    res.json({
      date,
      shop_id: shopId,
      already_submitted: allFilled,
      locked: anyLocked,
      items,
      groups
    });
  } catch (err) {
    console.error("getTodayCount:", err);
    res.status(500).json({ message: "Failed to load count grid" });
  }
};

/* POST /stock-count/save
   Body: { items: [{ stock_item_id, closing_qty, note? }], count_date? (admin override) }
   Cashier: only today's date, only if not already locked.
   Admin: any date.
   Saves each row + adjusts stock_items.current_qty + writes stock_logs (NIGHT_COUNT). */
exports.saveCount = async (req, res) => {
  const client = await DB.getClient();
  const shopId = req.shop_id;
  const isAdmin = req.role_type === 'Admin' || req.role_type === 'Manager';
  const userId = req.user_id;

  try {
    const { items, count_date, note } = req.body;
    const today = new Date().toISOString().slice(0, 10);

    if (!Array.isArray(items) || !items.length) {
      return res.status(400).json({ message: "items[] required" });
    }

    const date = (isAdmin && count_date) ? count_date : today;

    if (!isAdmin && date !== today) {
      return res.status(403).json({ message: "Cashier can only save today's count" });
    }

    // Lock policy:
    //  - Admin saves are authoritative → row is locked (cashier cannot overwrite).
    //  - Cashier saves stay unlocked so the cashier can keep editing the same
    //    row through the day (typos, late count corrections, etc.).
    //    Admin can still unlock/re-lock via the unlockRow endpoint.
    const lockOnSave = !!isAdmin;

    await client.query("BEGIN");

    for (const i of items) {
      const stockItemId = Number(i.stock_item_id);
      const closing     = Number(i.closing_qty);
      const purchaseQty = Number(i.purchase_qty || 0);
      const openingOverride = i.opening_qty != null && i.opening_qty !== '' ? Number(i.opening_qty) : null;
      if (!stockItemId || isNaN(closing) || closing < 0) continue;

      // Existing row?
      const existing = await client.query(
        `SELECT id, opening_qty, closing_qty, locked
         FROM stock_counts
         WHERE shop_id = $1 AND stock_item_id = $2 AND count_date = $3::date`,
        [shopId, stockItemId, date]
      );

      // Cashier cannot overwrite a locked row
      if (existing.rows.length && existing.rows[0].locked && !isAdmin) {
        continue;
      }

      // Get item meta + system qty
      const stk = await client.query(
        `SELECT current_qty, unit_label, unit_value FROM stock_items WHERE id = $1 AND shop_id = $2`,
        [stockItemId, shopId]
      );
      if (!stk.rows.length) continue;
      const itemMeta = stk.rows[0];
      let systemQty = Number(itemMeta.current_qty);

      // 1) Apply purchase first (creates stock_entry + adds to current_qty)
      if (purchaseQty > 0) {
        const baseQty = purchaseQty * Number(itemMeta.unit_value || 1);
        const entryRes = await client.query(
          `INSERT INTO stock_entries
             (stock_item_id, qty, unit, base_qty, remaining_qty, purchase_price, purchase_date, shop_id)
           VALUES ($1,$2,$3,$4,$4,0,$5::date,$6) RETURNING id`,
          [stockItemId, purchaseQty, itemMeta.unit_label, baseQty, date, shopId]
        );
        await client.query(
          `UPDATE stock_items SET current_qty = current_qty + $1, updated_at = NOW() WHERE id = $2 AND shop_id = $3`,
          [baseQty, stockItemId, shopId]
        );
        await client.query(
          `INSERT INTO stock_logs (stock_item_id, stock_entry_id, change_qty, action, note, shop_id)
           VALUES ($1,$2,$3,'STOCK_IN',$4,$5)`,
          [stockItemId, entryRes.rows[0].id, baseQty, `Purchase via Stock Sheet ${date}: ${purchaseQty} ${itemMeta.unit_label}`, shopId]
        );
        systemQty += baseQty;
      }

      // 2) Compute opening
      const prevClose = await client.query(
        `SELECT closing_qty FROM stock_counts
         WHERE stock_item_id = $1 AND shop_id = $2 AND count_date < $3::date
         ORDER BY count_date DESC LIMIT 1`,
        [stockItemId, shopId, date]
      );

      let opening;
      if (existing.rows.length) {
        opening = Number(existing.rows[0].opening_qty);
      } else {
        opening = prevClose.rows.length ? Number(prevClose.rows[0].closing_qty) : systemQty;
      }
      // Admin can override opening
      if (isAdmin && openingOverride != null && !isNaN(openingOverride)) {
        opening = openingOverride;
      }

      // variance = closing - systemQty (after purchase applied)
      const variance = closing - systemQty;

      // Upsert the count row
      if (existing.rows.length) {
        await client.query(
          `UPDATE stock_counts
           SET closing_qty = $1, variance = $2, note = COALESCE($3, note),
               counted_by = $4, updated_at = NOW(), locked = $6
           WHERE id = $5`,
          [closing, variance, i.note || null, userId, existing.rows[0].id, lockOnSave]
        );
      } else {
        await client.query(
          `INSERT INTO stock_counts
             (shop_id, stock_item_id, count_date, opening_qty, closing_qty, variance, counted_by, locked, note)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$9,$8)`,
          [shopId, stockItemId, date, opening, closing, variance, userId, i.note || null, lockOnSave]
        );
      }

      // Apply variance: bring stock_items.current_qty in line with the count
      if (variance !== 0) {
        await client.query(
          `UPDATE stock_items SET current_qty = $1, updated_at = NOW() WHERE id = $2 AND shop_id = $3`,
          [closing, stockItemId, shopId]
        );

        const logNote = `Night count ${date}: opening ${opening}, closing ${closing}, variance ${variance > 0 ? '+' : ''}${variance}${i.note ? ' — ' + i.note : ''}`;
        await client.query(
          `INSERT INTO stock_logs (stock_item_id, change_qty, action, note, shop_id)
           VALUES ($1, $2, 'NIGHT_COUNT', $3, $4)`,
          [stockItemId, variance, logNote, shopId]
        );
      }
    }

    await client.query("COMMIT");
    res.json({ ok: true, date, message: "Stock count saved" });
  } catch (err) {
    await client.query("ROLLBACK");
    console.error("saveCount:", err);
    res.status(500).json({ message: "Failed to save count", error: err.message });
  } finally {
    client.release();
  }
};

/* GET /stock-count/history?date=YYYY-MM-DD  (admin)
   Returns every count for a given date for current shop. */
exports.getHistory = async (req, res) => {
  try {
    const shopId = req.shop_id;
    const date = req.query.date || new Date().toISOString().slice(0, 10);

    const rows = await DB.PostgresAny(`
      SELECT
        sc.id, sc.stock_item_id,
        si.name, si.base_unit, si.unit_label,
        sc.opening_qty, sc.closing_qty, sc.variance,
        sc.locked, sc.note, sc.counted_by,
        u.user_name AS counted_by_name,
        sc.count_date, sc.created_at, sc.updated_at
      FROM stock_counts sc
      JOIN stock_items si ON si.id = sc.stock_item_id
      LEFT JOIN users u ON u.id = sc.counted_by
      WHERE sc.shop_id = $1 AND sc.count_date = $2::date
      ORDER BY si.name
    `, [shopId, date]);

    const summary = await DB.PostgresAny(`
      SELECT
        COUNT(*)::INT AS items_counted,
        SUM(CASE WHEN variance < 0 THEN 1 ELSE 0 END)::INT AS shortages,
        SUM(CASE WHEN variance > 0 THEN 1 ELSE 0 END)::INT AS surpluses,
        COALESCE(SUM(variance), 0) AS total_variance
      FROM stock_counts
      WHERE shop_id = $1 AND count_date = $2::date
    `, [shopId, date]);

    res.json({ date, items: rows, summary: summary[0] });
  } catch (err) {
    console.error("getHistory:", err);
    res.status(500).json({ message: "Failed to load history" });
  }
};

/* GET /stock-count/dates  (admin) → list of distinct dates with counts */
exports.getDates = async (req, res) => {
  try {
    const rows = await DB.PostgresAny(`
      SELECT DISTINCT count_date
      FROM stock_counts
      WHERE shop_id = $1
      ORDER BY count_date DESC
      LIMIT 60
    `, [req.shop_id]);
    res.json(rows.map(r => r.count_date));
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};

/* POST /stock-count/quick-add-item
   Inline create a stock_item from the Stock Sheet (admin or cashier).
   Body: { name, category_id?, unit_label, base_unit?, unit_value?, min_qty? } */
exports.quickAddItem = async (req, res) => {
  try {
    const { name, category_id, unit_label, base_unit, unit_value, min_qty } = req.body;
    if (!name || !unit_label) {
      return res.status(400).json({ message: "name and unit_label required" });
    }
    const row = await DB.PostgresInsert("stock_items", {
      name: String(name).trim(),
      category_id: category_id ? Number(category_id) : null,
      base_unit:   base_unit  || unit_label,
      unit_label,
      unit_value:  Number(unit_value) || 1,
      current_qty: 0,
      min_qty:     Number(min_qty) || 0,
      is_active:   true,
      shop_id:     req.shop_id
    });
    res.status(201).json({ ok: true, item: row });
  } catch (err) {
    console.error("quickAddItem:", err);
    res.status(500).json({ message: err.message });
  }
};

/* POST /stock-count/unlock/:id  (admin) — let cashier re-edit */
exports.unlockRow = async (req, res) => {
  try {
    if (req.role_type !== 'Admin' && req.role_type !== 'Manager') {
      return res.status(403).json({ message: "Admin or Manager access required" });
    }
    await DB.PostgresAny(
      `UPDATE stock_counts SET locked = false, updated_at = NOW()
       WHERE id = $1 AND shop_id = $2`,
      [req.params.id, req.shop_id]
    );
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};
