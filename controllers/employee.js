const DB = require("../middleware/dbFunctions");

exports.saveEmployee = async (req, res) => {
  const { id, name, join_date, salary_type, salary_amount, is_active = true } = req.body;
  const shopId = req.shop_id;

  if (!name || !join_date || !salary_type || !salary_amount) {
    return res.status(400).json({ message: "Missing required fields" });
  }
  if (!['WEEKLY', 'MONTHLY'].includes(salary_type)) {
    return res.status(400).json({ message: "Invalid salary type" });
  }

  if (id) {
    await DB.PostgresAny(
      `UPDATE employees
       SET name = $1, join_date = $2, salary_type = $3, salary_amount = $4, is_active = $5
       WHERE id = $6 AND shop_id = $7`,
      [name, join_date, salary_type, salary_amount, is_active, id, shopId]
    );
    return res.json({ message: "Employee updated successfully" });
  }

  await DB.PostgresAny(
    `INSERT INTO employees (name, join_date, salary_type, salary_amount, is_active, shop_id)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [name, join_date, salary_type, salary_amount, is_active, shopId]
  );

  res.json({ message: "Employee created successfully" });
};

exports.getEmployees = async (req, res) => {
  const data = await DB.PostgresAny(
    `SELECT id, name, join_date, salary_type, salary_amount, is_active
     FROM employees
     WHERE shop_id = $1
     ORDER BY name`,
    [req.shop_id]
  );
  res.json(data);
};

exports.deleteEmployee = async (req, res) => {
  const { id } = req.params;
  await DB.PostgresAny(
    `DELETE FROM employees WHERE id = $1 AND shop_id = $2`,
    [id, req.shop_id]
  );
  res.json({ message: "Employee deleted successfully" });
};
