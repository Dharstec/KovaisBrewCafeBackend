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
