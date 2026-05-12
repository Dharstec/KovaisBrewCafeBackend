-- Product add-ons for Zomato / Swiggy orders
-- Each product can have multiple named add-ons (e.g. Extra Cup ₹10, Extra Shot ₹30)
-- platform: 'zomato' | 'swiggy' | 'both'
CREATE TABLE IF NOT EXISTS product_addons (
  id         SERIAL PRIMARY KEY,
  product_id INT NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  name       VARCHAR(100) NOT NULL,
  price      DECIMAL(10,2) NOT NULL DEFAULT 0,
  platform   VARCHAR(20) NOT NULL DEFAULT 'both',
  shop_id    INT NOT NULL,
  created_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_product_addons_product ON product_addons(product_id);
CREATE INDEX IF NOT EXISTS idx_product_addons_shop    ON product_addons(shop_id);
