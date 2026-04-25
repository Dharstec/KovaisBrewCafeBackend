const DB = require("../middleware/dbFunctions");

exports.createCoupon = async (req, res) => {
  try {
    const {
      code, discount_type, discount_value,
      min_bill_amount = 0, max_discount = null,
      valid_from = null, valid_to = null,
      usage_limit = null, is_active = true
    } = req.body;
    const shopId = req.shop_id;

    if (!code || !discount_type || !discount_value) {
      return res.status(400).json({ msg: "Required fields missing" });
    }
    if (discount_value <= 0) {
      return res.status(400).json({ msg: "Invalid discount value" });
    }

    const exists = await DB.PostgresAny(
      `SELECT id FROM coupons WHERE code=$1 AND shop_id=$2`,
      [code, shopId]
    );
    if (exists.length) {
      return res.status(400).json({ msg: "Coupon code already exists" });
    }

    await DB.PostgresInsert("coupons", {
      code: code.toUpperCase(),
      discount_type, discount_value,
      min_bill_amount, max_discount,
      valid_from, valid_to, usage_limit, is_active,
      shop_id: shopId
    });

    res.json({ message: "Coupon created" });
  } catch (err) {
    console.error("Create coupon error:", err);
    res.status(500).json({ error: err.message });
  }
};

exports.getCoupons = async (req, res) => {
  try {
    const coupons = await DB.PostgresAny(
      `SELECT * FROM coupons WHERE shop_id=$1 ORDER BY created_at DESC`,
      [req.shop_id]
    );
    res.json(coupons);
  } catch (err) {
    console.error("Get coupons error:", err);
    res.status(500).json({ error: err.message });
  }
};

exports.getCouponById = async (req, res) => {
  try {
    const id = Number(req.params.id);
    const coupon = await DB.PostgresAny(
      `SELECT * FROM coupons WHERE id=$1 AND shop_id=$2`,
      [id, req.shop_id]
    );
    if (!coupon.length) return res.status(404).json({ msg: "Coupon not found" });
    res.json(coupon[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

exports.updateCoupon = async (req, res) => {
  try {
    const id = Number(req.params.id);
    const shopId = req.shop_id;

    const {
      code, discount_type, discount_value,
      min_bill_amount, max_discount,
      valid_from, valid_to, usage_limit, is_active
    } = req.body;

    const exists = await DB.PostgresAny(
      `SELECT id FROM coupons WHERE id=$1 AND shop_id=$2`,
      [id, shopId]
    );
    if (!exists.length) return res.status(404).json({ msg: "Coupon not found" });

    await DB.PostgresUpdate(
      "coupons",
      {
        code, discount_type, discount_value,
        min_bill_amount, max_discount,
        valid_from, valid_to, usage_limit, is_active
      },
      { id, shop_id: shopId }
    );

    res.json({ message: "Coupon updated" });
  } catch (err) {
    console.error("Update coupon error:", err);
    res.status(500).json({ error: err.message });
  }
};

exports.deleteCoupon = async (req, res) => {
  try {
    const id = Number(req.params.id);
    const exists = await DB.PostgresAny(
      `SELECT id FROM coupons WHERE id=$1 AND shop_id=$2`,
      [id, req.shop_id]
    );
    if (!exists.length) return res.status(404).json({ msg: "Coupon not found" });

    await DB.PostgresAny(`DELETE FROM coupons WHERE id=$1 AND shop_id=$2`, [id, req.shop_id]);
    res.json({ message: "Coupon deleted" });
  } catch (err) {
    console.error("Delete coupon error:", err);
    res.status(500).json({ error: err.message });
  }
};

exports.applyCoupon = async (req, res) => {
  try {
    const billId = Number(req.params.billId);
    const { coupon_code } = req.body;
    const shopId = req.shop_id;

    const bill = await DB.PostgresAny(
      `SELECT grand_total, status FROM bills WHERE id=$1 AND shop_id=$2`,
      [billId, shopId]
    );
    if (!bill.length || bill[0].status !== 'PENDING') {
      return res.status(400).json({ msg: "Invalid bill" });
    }

    const coupon = await DB.PostgresAny(
      `SELECT * FROM coupons
       WHERE code=$1 AND shop_id=$2
         AND is_active=true
         AND (valid_from IS NULL OR valid_from <= CURRENT_DATE)
         AND (valid_to IS NULL OR valid_to >= CURRENT_DATE)`,
      [coupon_code, shopId]
    );
    if (!coupon.length) return res.status(400).json({ msg: "Invalid or expired coupon" });

    const c = coupon[0];
    const grandTotal = Number(bill[0].grand_total);

    if (grandTotal < Number(c.min_bill_amount || 0)) {
      return res.status(400).json({
        msg: `Minimum bill ₹${c.min_bill_amount} required`
      });
    }

    let discount =
      c.discount_type === 'PERCENT'
        ? (grandTotal * c.discount_value) / 100
        : c.discount_value;

    if (c.max_discount && discount > c.max_discount) discount = c.max_discount;
    if (discount > grandTotal) discount = grandTotal;

    await DB.PostgresUpdate(
      "bills",
      { coupon_code, coupon_discount: discount },
      { id: billId, shop_id: shopId }
    );

    res.json({ coupon_discount: discount, payable: grandTotal - discount });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};
