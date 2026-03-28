const express    = require("express");
const router     = express.Router();
const c          = require("../controllers/product");
const { verifyToken } = require("../middleware/auth.js");

/* ── Menu Products ── */
router.get("/products_billing",  verifyToken, c.getAllProductsBilling);  // billing screen
router.get("/products",          verifyToken, c.getAllProducts);          // admin list (paginated)
router.get("/products/:id",      verifyToken, c.getProductById);          // single product
router.post("/products",         verifyToken, c.createProduct);           // create
router.put("/products/:id",      verifyToken, c.updateProduct);           // update
router.patch("/products/:id/toggle", verifyToken, c.toggleProduct);      // activate / deactivate
router.delete("/products/:id",   verifyToken, c.deleteProduct);           // soft delete

/* ── Recipes ── */
router.get("/recipes/:sale_product_id", verifyToken, c.getRecipeByProduct); // get recipe
router.post("/recipes",                 verifyToken, c.saveRecipe);          // save / replace recipe
router.delete("/recipes/:id",           verifyToken, c.deleteRecipe);        // delete one ingredient row

module.exports = router;
