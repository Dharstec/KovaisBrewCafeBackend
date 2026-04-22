-- ============================================================
-- MIGRATION: Link products directly to stock items
--
-- For direct-buy-and-sell products (e.g. Coke, chips, packets)
-- set stock_item_id so billing deducts the correct stock item
-- without relying on name matching.
--
-- Run once:
--   psql -d kovais_brew_cafe -f migrations/add_product_stock_link.sql
-- ============================================================

ALTER TABLE products
  ADD COLUMN IF NOT EXISTS stock_item_id INTEGER REFERENCES stock_items(id);

CREATE INDEX IF NOT EXISTS idx_products_stock_item
  ON products(stock_item_id)
  WHERE stock_item_id IS NOT NULL;
