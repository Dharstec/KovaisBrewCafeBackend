const express = require("express");
const router = express.Router();
const controller = require("../controllers/category.js"); 
const { verifyToken } = require("../middleware/auth.js");

router.get("/category",         verifyToken, controller.getAllCategories);
router.get("/category_billing", verifyToken, controller.getAllCategoriesBilling);
router.get("/category_stock",   verifyToken, controller.getAllCategoriesStock);


module.exports = router;
