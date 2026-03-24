const router = require("express").Router();
const c = require("../controllers/employee.js");
const { verifyToken } = require("../middleware/auth.js");

router.get("/employee", verifyToken, c.getEmployees);
router.post("/employee", verifyToken, c.saveEmployee);
router.put("/employee/:id", verifyToken, c.saveEmployee);
router.delete("/employee/:id", verifyToken, c.deleteEmployee);

module.exports = router;
