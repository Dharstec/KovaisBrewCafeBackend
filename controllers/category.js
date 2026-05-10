const DB = require("../middleware/dbFunctions");
const handleError = require("../helpers/handleError");

exports.getAllCategories = async (req, res) => {
  try {
    const data = await DB.PostgresAny(
      `SELECT id, name FROM categories WHERE status = true AND shop_id = $1 ORDER BY name`,
      [req.shop_id]
    );
    res.json({ success: true, data });
  } catch (error) {
    handleError(res, error, "Failed to fetch categories");
  }
};

exports.getAllCategoriesBilling = async (req, res) => {
  try {
    const data = await DB.PostgresAny(
      `SELECT id, name FROM categories
       WHERE status = true AND shop_id = $1 AND name NOT IN ('Stock Items')
       ORDER BY name`,
      [req.shop_id]
    );
    res.json({ success: true, data });
  } catch (error) {
    handleError(res, error, "Failed to fetch categories");
  }
};

/* Stock-only category list:
   - Categories that already have at least one stock_item linked, PLUS
   - the conventional 'Stock Items' fallback if it exists.
   - If the result is empty (fresh install), falls back to all categories.
   Use this for ingredient/stock create-edit dropdowns so users don't see
   product categories like "Beverages" mixed in. */
exports.getAllCategoriesStock = async (req, res) => {
  try {
    const shopId = req.shop_id;
    const data = await DB.PostgresAny(
      `SELECT DISTINCT c.id, c.name
         FROM categories c
         LEFT JOIN stock_items si
                ON si.category_id = c.id AND si.shop_id = $1
        WHERE c.status = true
          AND c.shop_id = $1
          AND (si.id IS NOT NULL OR c.name = 'Stock Items')
        ORDER BY c.name`,
      [shopId]
    );

    if (data.length) {
      return res.json({ success: true, data });
    }

    // Fallback for empty stock setup — return all so user has *something* to pick.
    const all = await DB.PostgresAny(
      `SELECT id, name FROM categories
        WHERE status = true AND shop_id = $1
        ORDER BY name`,
      [shopId]
    );
    res.json({ success: true, data: all });
  } catch (error) {
    handleError(res, error, "Failed to fetch stock categories");
  }
};
