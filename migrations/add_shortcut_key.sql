-- Add keyboard shortcut key to products
-- shortcut_key stores a single letter (a-z / 0-9).
-- On the billing screen, pressing Shift+<letter> instantly adds the product to cart.
ALTER TABLE products
  ADD COLUMN IF NOT EXISTS shortcut_key VARCHAR(10) DEFAULT NULL;

-- Optional: enforce uniqueness per shop so two products don't share the same shortcut
CREATE UNIQUE INDEX IF NOT EXISTS uix_products_shortcut_key_shop
  ON products (shop_id, shortcut_key)
  WHERE shortcut_key IS NOT NULL;
