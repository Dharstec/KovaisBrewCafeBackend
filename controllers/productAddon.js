const DB = require("../middleware/dbFunctions");

exports.getAddons = async (req, res) => {
  try {
    const productId = Number(req.params.productId);
    const shopId    = req.shop_id;

    const data = await DB.PostgresAny(
      `SELECT id, name, price
       FROM product_addons
       WHERE product_id = $1 AND shop_id = $2
       ORDER BY id ASC`,
      [productId, shopId]
    );
    res.json(data);
  } catch (err) {
    console.error("Get addons error:", err);
    res.status(500).json({ error: err.message });
  }
};

exports.createAddon = async (req, res) => {
  try {
    const productId          = Number(req.params.productId);
    const shopId             = req.shop_id;
    const { name, price } = req.body;

    if (!name || name.trim() === '') {
      return res.status(400).json({ message: "name is required" });
    }
    if (price == null || isNaN(Number(price)) || Number(price) < 0) {
      return res.status(400).json({ message: "price must be >= 0" });
    }

    const product = await DB.PostgresAny(
      `SELECT id FROM products WHERE id = $1 AND shop_id = $2`,
      [productId, shopId]
    );
    if (!product.length) {
      return res.status(404).json({ message: "Product not found" });
    }

    const row = await DB.PostgresInsert("product_addons", {
      product_id: productId,
      name:       name.trim(),
      price:      Number(price),
      shop_id:    shopId
    });
    res.status(201).json(row);
  } catch (err) {
    console.error("Create addon error:", err);
    res.status(500).json({ error: err.message });
  }
};

exports.deleteAddon = async (req, res) => {
  try {
    const addonId = Number(req.params.addonId);
    const shopId  = req.shop_id;

    const rows = await DB.PostgresAny(
      `SELECT id FROM product_addons WHERE id = $1 AND shop_id = $2`,
      [addonId, shopId]
    );
    if (!rows.length) {
      return res.status(404).json({ message: "Add-on not found" });
    }

    await DB.PostgresAny(
      `DELETE FROM product_addons WHERE id = $1 AND shop_id = $2`,
      [addonId, shopId]
    );
    res.json({ message: "Add-on deleted" });
  } catch (err) {
    console.error("Delete addon error:", err);
    res.status(500).json({ error: err.message });
  }
};
