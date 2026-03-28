const express    = require("express");
const router     = express.Router();
const c          = require("../controllers/stockItem");
const { verifyToken } = require("../middleware/auth.js");

router.get("/stock-items",              verifyToken, c.getAllStockItems);      // list (?search=&low_stock=true)
router.get("/stock-items/dropdown",     verifyToken, c.getStockItemsDropdown); // for recipe builder
router.get("/stock-items/:id",          verifyToken, c.getStockItemById);      // detail + batches + logs
router.post("/stock-items",             verifyToken, c.createStockItem);       // Add button
router.put("/stock-items/:id",          verifyToken, c.updateStockItem);       // Edit
router.patch("/stock-items/:id/toggle", verifyToken, c.toggleStockItem);      // activate / deactivate
router.delete("/stock-items/:id",       verifyToken, c.deleteStockItem);       // soft delete

module.exports = router;
