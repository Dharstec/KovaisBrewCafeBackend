const router = require("express").Router();
const c = require("../controllers/dashboard");
const { verifyToken } = require("../middleware/auth.js");

router.get("/dashboard/summary",           verifyToken, c.getDashboardSummary);
router.get("/dashboard/sales_chart",       verifyToken, c.getItemSalesChart);
router.get("/dashboard/hourly_sales",      verifyToken, c.getHourlyItemSales);
router.get("/dashboard/payment_breakdown", verifyToken, c.getPaymentBreakdown);
router.get("/dashboard/daily_spend",       verifyToken, c.getDailySpend);
router.get("/dashboard/range_summary",     verifyToken, c.getRangeSummary);

module.exports = router;
