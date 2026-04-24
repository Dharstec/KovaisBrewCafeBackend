const jwt = require("jsonwebtoken");
require('dotenv').config();

/* ─────────────────────────────────────────────────────────
   verifyToken
   - Decodes JWT
   - Sets req.user_id, req.role_type, req.user_shop_id
   - Resolves the EFFECTIVE shop for this request:
       • Cashier (shop_id set in JWT) → forced to that shop
       • Admin   (shop_id NULL in JWT) → uses X-Shop-Id header,
                                         falls back to shop 1
   - Writes result to req.shop_id
   ───────────────────────────────────────────────────────── */
exports.verifyToken = (req, res, next) => {
  const tokenWithBearer = req.headers["authorization"];

  if (!tokenWithBearer) {
    return res.status(403).send({ message: "No token provided!" });
  }

  const parts = tokenWithBearer.split(' ');
  if (parts.length !== 2 || parts[0] !== "Bearer") {
    return res.status(401).send({ message: "Token format is invalid. Token should be a 'Bearer [token]'." });
  }
  const token = parts[1];

  jwt.verify(token, process.env.SECRET_CODE, (err, decoded) => {
    if (err) {
      return res.status(401).send({ message: "Unauthorized!" });
    }

    req.user_name     = decoded.user_name;
    req.user_id       = decoded.user_id;
    req.role_type     = decoded.role_type;
    req.email         = decoded.email;
    req.user_shop_id  = decoded.shop_id ?? null;  // what the JWT says (null = admin/all-shops)

    /* Resolve effective shop for this request */
    const headerShopRaw = req.headers['x-shop-id'];
    const headerShopId  = headerShopRaw != null ? parseInt(headerShopRaw, 10) : NaN;

    if (req.user_shop_id) {
      // Cashier is locked to their shop
      req.shop_id = req.user_shop_id;
    } else {
      // Admin: choose from header, default to shop 1
      req.shop_id = Number.isInteger(headerShopId) && headerShopId > 0 ? headerShopId : 1;
    }

    next();
  });
};

/* Admin-only guard — use after verifyToken */
exports.requireAdmin = (req, res, next) => {
  if (req.role_type !== 'Admin') {
    return res.status(403).json({ message: 'Admin access required' });
  }
  next();
};
