const DB = require("../middleware/dbFunctions");

/* =========================================================
   PRODUCTS  — menu items (scoped per shop)
   ========================================================= */

exports.getAllProductsBilling = async (req, res) => {
  try {
    const { search, category_id } = req.query;
    const shopId = req.shop_id;

    const params = [shopId];
    let query = `
      SELECT
        p.id, p.name, p.price,
        p.zomato_price, p.swiggy_price,
        p.zomato_packing, p.swiggy_packing,
        p.image_url, p.category_id, p.is_manual_price,
        c.name AS category, p.stock_item_id,
        EXISTS(SELECT 1 FROM product_recipes pr WHERE pr.sale_product_id = p.id AND pr.shop_id = $1) AS has_recipe,
        CASE
          WHEN EXISTS(SELECT 1 FROM product_recipes pr WHERE pr.sale_product_id = p.id AND pr.shop_id = $1)
          THEN (
            SELECT MIN(FLOOR(si.current_qty / NULLIF(pr.used_qty, 0)))
            FROM product_recipes pr
            JOIN stock_items si ON si.id = COALESCE(pr.stock_item_id, pr.raw_product_id)
            WHERE pr.sale_product_id = p.id AND pr.shop_id = $1 AND si.shop_id = $1
          )
          WHEN p.stock_item_id IS NOT NULL
          THEN (
            SELECT FLOOR(si.current_qty)
            FROM stock_items si
            WHERE si.id = p.stock_item_id AND si.is_active = true AND si.shop_id = $1
          )
          ELSE NULL
        END AS servings_possible
      FROM products p
      JOIN categories c ON c.id = p.category_id
      WHERE p.is_active = true
        AND p.is_sellable = true
        AND p.shop_id = $1`;

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

exports.getAllProducts = async (req, res) => {
  try {
    const { search = '', category_id, page = 1, limit = 10 } = req.query;
    const shopId = req.shop_id;

    const pageNo   = Number(page);
    const pageSize = Number(limit);
    const offset   = (pageNo - 1) * pageSize;

    const params = [shopId];
    let where = `WHERE p.is_active = true AND p.shop_id = $1`;

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
        p.id, p.name, p.price,
        p.zomato_price, p.swiggy_price,
        p.zomato_packing, p.swiggy_packing,
        p.image_url, p.category_id,
        p.is_sellable, p.is_manual_price, p.is_active,
        p.stock_item_id,
        c.name AS category_name,
        si.name AS stock_item_name,
        (SELECT COUNT(*) FROM product_recipes pr
         WHERE pr.sale_product_id = p.id
           AND COALESCE(pr.stock_item_id, pr.raw_product_id) IS NOT NULL
           AND pr.shop_id = $1
        ) AS recipe_count
      FROM products p
      LEFT JOIN categories c ON c.id = p.category_id
      LEFT JOIN stock_items si ON si.id = p.stock_item_id
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

exports.getProductById = async (req, res) => {
  try {
    const data = await DB.PostgresAny(`
      SELECT p.id, p.name, p.price, p.zomato_price, p.swiggy_price,
             p.zomato_packing, p.swiggy_packing,
             p.image_url, p.category_id, p.stock_item_id,
             p.is_sellable, p.is_manual_price, p.is_active,
             c.name AS category_name,
             si.name AS stock_item_name
      FROM products p
      LEFT JOIN categories c ON c.id = p.category_id
      LEFT JOIN stock_items si ON si.id = p.stock_item_id
      WHERE p.id = $1 AND p.shop_id = $2
    `, [Number(req.params.id), req.shop_id]);

    if (!data.length) return res.status(404).json({ msg: "Product not found" });
    res.json(data[0]);
  } catch (err) {
    console.error("Get product error:", err);
    res.status(500).json({ msg: "Server error" });
  }
};

exports.createProduct = async (req, res) => {
  try {
    const {
      name, category_id, price,
      zomato_price, swiggy_price,
      zomato_packing, swiggy_packing,
      image_url, stock_item_id,
      is_sellable = true, is_manual_price = false
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
      zomato_price:    zomato_price   != null && zomato_price   !== '' ? Number(zomato_price)   : null,
      swiggy_price:    swiggy_price   != null && swiggy_price   !== '' ? Number(swiggy_price)   : null,
      zomato_packing:  zomato_packing != null && zomato_packing !== '' ? Number(zomato_packing) : null,
      swiggy_packing:  swiggy_packing != null && swiggy_packing !== '' ? Number(swiggy_packing) : null,
      image_url:       image_url || null,
      stock_item_id:   stock_item_id ? Number(stock_item_id) : null,
      is_sellable:     !!is_sellable,
      is_manual_price: !!is_manual_price,
      base_unit:       'pcs',
      unit_label:      'pcs',
      is_active:       true,
      shop_id:         req.shop_id
    });

    res.status(201).json({ success: true, product });
  } catch (err) {
    console.error("Create product error:", err);
    res.status(500).json({ msg: err.message });
  }
};

exports.updateProduct = async (req, res) => {
  try {
    const { name, category_id, price, zomato_price, swiggy_price, zomato_packing, swiggy_packing, image_url, stock_item_id, is_sellable, is_manual_price, is_active } = req.body;

    const payload = {};
    if (name            !== undefined) payload.name            = name;
    if (category_id     !== undefined) payload.category_id     = Number(category_id);
    if (is_sellable     !== undefined) payload.is_sellable     = !!is_sellable;
    if (is_manual_price !== undefined) payload.is_manual_price = !!is_manual_price;
    if (is_active       !== undefined) payload.is_active       = !!is_active;
    if (image_url       !== undefined) payload.image_url       = image_url || null;
    if (price           !== undefined) payload.price           = Number(price);
    if (zomato_price    !== undefined) payload.zomato_price    = zomato_price   !== '' && zomato_price   != null ? Number(zomato_price)   : null;
    if (swiggy_price    !== undefined) payload.swiggy_price    = swiggy_price   !== '' && swiggy_price   != null ? Number(swiggy_price)   : null;
    if (zomato_packing  !== undefined) payload.zomato_packing  = zomato_packing !== '' && zomato_packing != null ? Number(zomato_packing) : null;
    if (swiggy_packing  !== undefined) payload.swiggy_packing  = swiggy_packing !== '' && swiggy_packing != null ? Number(swiggy_packing) : null;
    if (stock_item_id   !== undefined) payload.stock_item_id   = stock_item_id ? Number(stock_item_id) : null;

    payload.updated_at = new Date();

    if (Object.keys(payload).length === 1) {
      return res.status(400).json({ msg: "No fields to update" });
    }

    const updated = await DB.PostgresUpdate("products", payload, { id: Number(req.params.id), shop_id: req.shop_id });
    if (!updated) return res.status(404).json({ msg: "Product not found" });

    res.json({ success: true, message: "Product updated" });
  } catch (err) {
    console.error("Update product error:", err);
    res.status(500).json({ msg: "Update failed" });
  }
};

exports.toggleProduct = async (req, res) => {
  try {
    const product = await DB.PostgresAny(
      `SELECT id, is_active FROM products WHERE id = $1 AND shop_id = $2`,
      [Number(req.params.id), req.shop_id]
    );
    if (!product.length) return res.status(404).json({ msg: "Product not found" });

    const updated = await DB.PostgresUpdate(
      "products",
      { is_active: !product[0].is_active, updated_at: new Date() },
      { id: Number(req.params.id), shop_id: req.shop_id }
    );
    res.json({ success: true, is_active: updated.is_active });
  } catch (err) {
    console.error("Toggle product error:", err);
    res.status(500).json({ msg: "Toggle failed" });
  }
};

exports.deleteProduct = async (req, res) => {
  try {
    const updated = await DB.PostgresUpdate(
      "products",
      { is_active: false, updated_at: new Date() },
      { id: Number(req.params.id), shop_id: req.shop_id }
    );
    if (!updated) return res.status(404).json({ msg: "Product not found" });
    res.json({ success: true, message: "Product deleted" });
  } catch (err) {
    console.error("Delete product error:", err);
    res.status(500).json({ msg: "Delete failed" });
  }
};

exports.getRecipeByProduct = async (req, res) => {
  try {
    const data = await DB.PostgresAny(`
      SELECT
        pr.id,
        COALESCE(pr.stock_item_id, pr.raw_product_id) AS stock_item_id,
        si.name  AS stock_item_name,
        si.base_unit, si.unit_label,
        pr.used_qty,
        ROUND(si.current_qty, 2) AS current_qty,
        FLOOR(si.current_qty / NULLIF(pr.used_qty, 0)) AS servings_from_this
      FROM product_recipes pr
      JOIN stock_items si ON si.id = COALESCE(pr.stock_item_id, pr.raw_product_id)
      WHERE pr.sale_product_id = $1
        AND COALESCE(pr.stock_item_id, pr.raw_product_id) IS NOT NULL
        AND pr.shop_id = $2
      ORDER BY si.name
    `, [req.params.sale_product_id, req.shop_id]);
    res.json(data);
  } catch (err) {
    console.error("Get recipe error:", err);
    res.status(500).json({ msg: "Server error" });
  }
};

exports.saveRecipe = async (req, res) => {
  try {
    const { sale_product_id, items } = req.body;
    const shopId = req.shop_id;

    if (!sale_product_id || !Array.isArray(items)) {
      return res.status(400).json({ msg: "sale_product_id and items[] required" });
    }

    await DB.PostgresAny(
      `DELETE FROM product_recipes WHERE sale_product_id = $1 AND shop_id = $2`,
      [sale_product_id, shopId]
    );

    for (const item of items) {
      const stock_item_id = Number(item.stock_item_id || item.raw_product_id);
      if (!stock_item_id || isNaN(stock_item_id) || !item.used_qty) continue;
      await DB.PostgresInsert("product_recipes", {
        sale_product_id: Number(sale_product_id),
        stock_item_id,
        used_qty: Number(item.used_qty),
        shop_id: shopId
      });
    }

    res.json({ success: true, message: "Recipe saved" });
  } catch (err) {
    console.error("Save recipe error:", err);
    res.status(500).json({ msg: "Save failed" });
  }
};

exports.deleteRecipe = async (req, res) => {
  try {
    await DB.PostgresAny(
      `DELETE FROM product_recipes WHERE id = $1 AND shop_id = $2`,
      [req.params.id, req.shop_id]
    );
    res.json({ success: true });
  } catch (err) {
    console.error("Delete recipe error:", err);
    res.status(500).json({ msg: "Delete failed" });
  }
};
