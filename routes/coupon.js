const router = require("express").Router();
const c = require("../controllers/coupon");
const { verifyToken } = require("../middleware/auth.js");

router.post("/coupons", verifyToken, c.createCoupon);
router.get("/coupons", verifyToken, c.getCoupons);
router.get("/coupons/:id", verifyToken, c.getCouponById);
router.put("/coupons/:id", verifyToken, c.updateCoupon);
router.delete("/coupons/:id", verifyToken, c.deleteCoupon);

router.post("/apply/:billId", verifyToken, c.applyCoupon);

module.exports = router;
