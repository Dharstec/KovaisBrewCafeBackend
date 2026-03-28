const DB = require("../middleware/dbFunctions");

/* =========================================================
   PRODUCTS = MENU ITEMS only
   (Latte, Tea, Snacks, Coke, etc.)

   NO stock fields here.
   Raw materials live in stock_items table.
   ========================================================= */


/* ─────────────────────────────────────────────────────────
   BILLING PRODUCT LIST  (lean, for billing screen)
   ───────────────────────────────────────────────────────── */
exports.getAllProductsBilling = async (req, res) => {
  try {
    const { search, category_id } = req.query;

    let query = `
      SELECT
        p.id,
        p.name,
        p.price,
        p.image_url,
        p.category_id,
        p.is_manual_price,
        c.name AS category
      FROM products p
      JOIN categories c ON c.id = p.category_id
      WHERE p.is_active   = true
        AND p.is_sellable = true`;

    const params = [];
    if (search) {
      params.push(`%${search.toLowerCase()}%`);
      query += ` AND LOWER(p.name) LIKE $${params.length}`;
    }
    if (category_id) {
      params.push(category_id);
      query += ` AND p.category_id = $${params.length}`;
    }
    query += ` ORDER BY c.name, p.name`;

    res.json(await DB.PostgresAny(query, params));
  } catch (err) {
    console.error("Billing products error:", err);
    res.status(500).json({ msg: "Server error" });
  }
};


/* ─────────────────────────────────────────────────────────
   LIST ALL PRODUCTS  (admin page, paginated)
   ───────────────────────────────────────────────────────── */
exports.getAllProducts = async (req, res) => {
  try {
    const { search = '', category_id, page = 1, limit = 10 } = req.query;

    const pageNo   = Number(page);
    const pageSize = Number(limit);
    const offset   = (pageNo - 1) * pageSize;

    let where = `WHERE p.is_active = true`;
    const params = [];

    if (search) {
      params.push(`%${search.toLowerCase()}%`);
      where += ` AND LOWER(p.name) LIKE $${params.length}`;
    }
    if (category_id) {
      params.push(category_id);
      where += ` AND p.category_id = $${params.length}`;
    }

    const products = await DB.PostgresAny(`
      SELECT
        p.id,
        p.name,
        p.price,
        p.image_url,
        p.category_id,
        p.is_sellable,
        p.is_manual_price,
        p.is_active,
        c.name AS category_name
      FROM products p
      LEFT JOIN categories c ON c.id = p.category_id
      ${where}
      ORDER BY c.name, p.name
      LIMIT $${params.length + 1} OFFSET $${params.length + 2}
    `, [...params, pageSize, offset]);

    const count = await DB.PostgresAny(
      `SELECT COUNT(*) AS total FROM products p ${where}`,
      params
    );

    res.json({
      data:       products,
      page:       pageNo,
      limit:      pageSize,
      total:      Number(count[0].total),
      totalPages: Math.ceil(Number(count[0].total) / pageSize)
    });
  } catch (err) {
    console.error("Get products error:", err);
    res.status(500).json({ msg: "Server error" });
  }
};


/* ─────────────────────────────────────────────────────────
   GET PRODUCT BY ID
   ───────────────────────────────────────────────────────── */
exports.getProductById = async (req, res) => {
  try {
    const data = await DB.PostgresAny(`
      SELECT p.id, p.name, p.price, p.image_url, p.category_id,
             p.is_sellable, p.is_manual_price, p.is_active,
             c.name AS category_name
      FROM products p
      LEFT JOIN categories c ON c.id = p.category_id
      WHERE p.id = $1
    `, [Number(req.params.id)]);

    if (!data.length) return res.status(404).json({ msg: "Product not found" });
    res.json(data[0]);
  } catch (err) {
    console.error("Get product error:", err);
    res.status(500).json({ msg: "Server error" });
  }
};


/* ─────────────────────────────────────────────────────────
   CREATE PRODUCT
   Required: name, category_id
   Sellable products also need: price (or is_manual_price=true)
   ───────────────────────────────────────────────────────── */
exports.createProduct = async (req, res) => {
  try {
    const {
      name,
      category_id,
      price,
      image_url,
      is_sellable     = true,
      is_manual_price = false
    } = req.body;

    if (!name || !category_id) {
      return res.status(400).json({ msg: "name and category_id are required" });
    }
    if (is_sellable && !is_manual_price && (price === undefined || price === null)) {
      return res.status(400).json({ msg: "price required (or set is_manual_price=true)" });
    }

    const product = await DB.PostgresInsert("products", {
      name,
      category_id:     Number(category_id),
      price:           is_manual_price ? 0 : Number(price),
      image_url:       image_url || null,
      is_sellable:     !!is_sellable,
      is_manual_price: !!is_manual_price,
      is_active:       true,
      // keep required DB columns at safe defaults
      base_unit:   'pcs',
      unit_label:  'piece',
      unit_value:  1,
      track_stock: false,
      current_qty: 0,
      min_qty:     0
    });

    res.status(201).json({ success: true, product });
  } catch (err) {
    console.error("Create product error:", err);
    res.status(500).json({ msg: err.message });
  }
};


/* ─────────────────────────────────────────────────────────
   UPDATE PRODUCT
   ───────────────────────────────────────────────────────── */
exports.updateProduct = async (req, res) => {
  try {
    const { name, category_id, price, image_url, is_sellable, is_manual_price, is_active } = req.body;

    const payload = {};
    if (name            !== undefined) payload.name            = name;
    if (category_id     !== undefined) payload.category_id     = Number(category_id);
    if (is_sellable     !== undefined) payload.is_sellable     = !!is_sellable;
    if (is_manual_price !== undefined) payload.is_manual_price = !!is_manual_price;
    if (is_active       !== undefined) payload.is_active       = !!is_active;
    if (image_url       !== undefined) payload.image_url       = image_url || null;
    if (price           !== undefined) payload.price           = Number(price);

    payload.updated_at = new Date();

    if (Object.keys(payload).length === 1) {
      return res.status(400).json({ msg: "No fields to update" });
    }

    const updated = await DB.PostgresUpdate("products", payload, { id: Number(req.params.id) });
    if (!updated) return res.status(404).json({ msg: "Product not found" });

    res.json({ success: true, message: "Product updated" });
  } catch (err) {
    console.error("Update product error:", err);
    res.status(500).json({ msg: "Update failed" });
  }
};


/* ─────────────────────────────────────────────────────────
   TOGGLE ACTIVE / INACTIVE
   ───────────────────────────────────────────────────────── */
exports.toggleProduct = async (req, res) => {
  try {
    const product = await DB.PostgresAny(
      `SELECT id, is_active FROM products WHERE id = $1`,
      [Number(req.params.id)]
    );
    if (!product.length) return res.status(404).json({ msg: "Product not found" });

    const updated = await DB.PostgresUpdate(
      "products",
      { is_active: !product[0].is_active, updated_at: new Date() },
      { id: Number(req.params.id) }
    );
    res.json({ success: true, is_active: updated.is_active });
  } catch (err) {
    console.error("Toggle product error:", err);
    res.status(500).json({ msg: "Toggle failed" });
  }
};


/* ─────────────────────────────────────────────────────────
   DELETE PRODUCT  (soft delete)
   ───────────────────────────────────────────────────────── */
exports.deleteProduct = async (req, res) => {
  try {
    const updated = await DB.PostgresUpdate(
      "products",
      { is_active: false, updated_at: new Date() },
      { id: Number(req.params.id) }
    );
    if (!updated) return res.status(404).json({ msg: "Product not found" });
    res.json({ success: true, message: "Product deleted" });
  } catch (err) {
    console.error("Delete product error:", err);
    res.status(500).json({ msg: "Delete failed" });
  }
};


/* ─────────────────────────────────────────────────────────
   RECIPE — get ingredients (links to stock_items)
   ───────────────────────────────────────────────────────── */
exports.getRecipeByProduct = async (req, res) => {
  try {
    const data = await DB.PostgresAny(`
      SELECT
        pr.id,
        pr.stock_item_id,
        si.name       AS stock_item_name,
        si.base_unit,
        si.unit_label,
        pr.used_qty
      FROM product_recipes pr
      JOIN stock_items si ON si.id = pr.stock_item_id
      WHERE pr.sale_product_id = $1
      ORDER BY si.name
    `, [req.params.sale_product_id]);
    res.json(data);
  } catch (err) {
    console.error("Get recipe error:", err);
    res.status(500).json({ msg: "Server error" });
  }
};


/* ─────────────────────────────────────────────────────────
   RECIPE — save ingredients (replaces all rows)
   items: [{ stock_item_id, used_qty }]
   ───────────────────────────────────────────────────────── */
exports.saveRecipe = async (req, res) => {
  try {
    const { sale_product_id, items } = req.body;

    if (!sale_product_id || !Array.isArray(items)) {
      return res.status(400).json({ msg: "sale_product_id and items[] required" });
    }

    await DB.PostgresAny(
      `DELETE FROM product_recipes WHERE sale_product_id = $1`,
      [sale_product_id]
    );

    for (const item of items) {
      if (!item.stock_item_id || !item.used_qty) continue;
      await DB.PostgresInsert("product_recipes", {
        sale_product_id,
        stock_item_id:  item.stock_item_id,
        used_qty:       Number(item.used_qty)
      });
    }

    res.json({ success: true, message: "Recipe saved" });
  } catch (err) {
    console.error("Save recipe error:", err);
    res.status(500).json({ msg: "Save failed" });
  }
};


/* ─────────────────────────────────────────────────────────
   RECIPE — delete single ingredient row
   ───────────────────────────────────────────────────────── */
exports.deleteRecipe = async (req, res) => {
  try {
    await DB.PostgresAny(`DELETE FROM product_recipes WHERE id = $1`, [req.params.id]);
    res.json({ success: true });
  } catch (err) {
    console.error("Delete recipe error:", err);
    res.status(500).json({ msg: "Delete failed" });
  }
};
