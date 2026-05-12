const DB = require("../middleware/dbFunctions");

exports.addAdvance = async (req, res) => {
  try {
    const { employee_id, amount, advance_date, note } = req.body;
    const shopId = req.shop_id;

    if (!employee_id || !amount || !advance_date) {
      return res.status(400).json({ message: "Missing required fields" });
    }

    await DB.PostgresInsert("employee_advance", {
      employee_id,
      amount,
      advance_date,
      note: note || null,
      shop_id: shopId
    });

    res.json({ message: "Advance added successfully" });
  } catch (err) {
    console.error("Add advance error:", err);
    res.status(500).json({ error: err.message });
  }
};

exports.getAdvanceHistory = async (req, res) => {
  try {
    const { employee_id } = req.query;
    if (!employee_id) {
      return res.status(400).json({ message: "employee_id is required" });
    }

    const data = await DB.PostgresAny(
      `SELECT *
       FROM employee_advance
       WHERE employee_id = $1 AND shop_id = $2
       ORDER BY advance_date DESC`,
      [employee_id, req.shop_id]
    );

    res.json(data);
  } catch (err) {
    console.error("Advance history error:", err);
    res.status(500).json({ error: err.message });
  }
};

exports.deleteAdvance = async (req, res) => {
  try {
    const { id } = req.params;
    const shopId = req.shop_id;

    const rows = await DB.PostgresAny(
      `SELECT id FROM employee_advance WHERE id = $1 AND shop_id = $2`,
      [id, shopId]
    );

    if (!rows.length) {
      return res.status(404).json({ message: "Advance record not found" });
    }

    await DB.PostgresAny(
      `DELETE FROM employee_advance WHERE id = $1 AND shop_id = $2`,
      [id, shopId]
    );

    res.json({ message: "Advance deleted successfully" });
  } catch (err) {
    console.error("Delete advance error:", err);
    res.status(500).json({ error: err.message });
  }
};
