const router = require("express").Router();
const c = require("../controllers/stock.js");
const { verifyToken } = require("../middleware/auth.js");

/* ── Stock levels ── */
router.get("/stock",               verifyToken, c.getStock);             // current qty for all items
router.get("/stock_dropdown",      verifyToken, c.getDropDownStock);     // for recipe builder

/* ── Add stock (purchase entry) ── */
router.post("/stock/add",          verifyToken, c.addStockEntry);        // Add button — qty + price + expiry

/* ── Stock entries (purchase history / price tracking) ── */
router.get("/stock/entries",       verifyToken, c.getStockEntries);      // all entries (?stock_item_id=X)
router.get("/stock/price-history/:stock_item_id", verifyToken, c.getPriceHistory); // price trend for one item

/* ── Expiry alerts ── */
router.get("/stock/expiring",      verifyToken, c.getExpiringEntries);   // ?days=7

/* ── Manual adjustment ── */
router.post("/stock/adjust",       verifyToken, c.adjustStock);          // wastage / correction

/* ── Stock logs (separate page) ── */
router.get("/stock/logs",          verifyToken, c.getStockLogs);         // all movements (?stock_item_id=X&action=STOCK_IN)

module.exports = router;
