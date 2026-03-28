-- ============================================================
-- MIGRATION: Separate stock_items table
-- Products page  = menu items only  (products table)
-- Stock page     = raw materials    (stock_items table)
-- Run once:
--   psql -d kovais_brew_cafe -f migrations/stock_items_table.sql
-- ============================================================


-- 1. CREATE stock_items TABLE
-- ============================================================
CREATE TABLE IF NOT EXISTS stock_items (
  id           SERIAL PRIMARY KEY,
  name         VARCHAR(150)  NOT NULL,
  category_id  INT           REFERENCES categories(id),

  -- Unit setup
  -- base_unit  = smallest stored unit  : gm | ml | pcs
  -- unit_label = display name          : kg | litre | packet | piece
  -- unit_value = base_units per label  : 1000 (kg→gm) | 100 (packet→gm)
  base_unit    VARCHAR(20)   NOT NULL DEFAULT 'pcs',
  unit_label   VARCHAR(20)   NOT NULL DEFAULT 'piece',
  unit_value   NUMERIC(10,3) NOT NULL DEFAULT 1,

  -- Live stock level (updated by receive / billing / adjust)
  current_qty  NUMERIC(10,3) NOT NULL DEFAULT 0,
  min_qty      NUMERIC(10,3) NOT NULL DEFAULT 0,   -- low-stock alert threshold

  is_active    BOOLEAN       NOT NULL DEFAULT TRUE,
  created_at   TIMESTAMP              DEFAULT NOW(),
  updated_at   TIMESTAMP              DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_stock_items_active
  ON stock_items(is_active);


-- 2. MIGRATE existing track_stock products → stock_items
--    Preserve the same IDs so existing recipe & log links stay valid
-- ============================================================
INSERT INTO stock_items
  (id, name, category_id, base_unit, unit_label, unit_value,
   current_qty, min_qty, is_active, created_at, updated_at)
SELECT
  id,
  name,
  category_id,
  COALESCE(base_unit,  'pcs'),
  COALESCE(unit_label, 'piece'),
  COALESCE(unit_value, 1),
  COALESCE(current_qty, 0),
  COALESCE(min_qty,     0),
  is_active,
  created_at,
  updated_at
FROM products
WHERE track_stock = true
ON CONFLICT (id) DO NOTHING;

-- Reset sequence so new inserts don't collide
SELECT setval(
  'stock_items_id_seq',
  COALESCE((SELECT MAX(id) FROM stock_items), 1)
);


-- 3. ADD stock_item_id TO product_recipes
--    (recipe: product uses X units of a stock_item)
-- ============================================================
ALTER TABLE product_recipes
  ADD COLUMN IF NOT EXISTS stock_item_id INT REFERENCES stock_items(id);

-- Migrate: where raw_product_id matched a stock item, copy it
UPDATE product_recipes pr
SET    stock_item_id = pr.raw_product_id
WHERE  EXISTS (
  SELECT 1 FROM stock_items si WHERE si.id = pr.raw_product_id
);


-- 4. ADD stock_item_id TO stock_batches
-- ============================================================
ALTER TABLE stock_batches
  ADD COLUMN IF NOT EXISTS stock_item_id INT REFERENCES stock_items(id);

UPDATE stock_batches sb
SET    stock_item_id = sb.product_id
WHERE  EXISTS (
  SELECT 1 FROM stock_items si WHERE si.id = sb.product_id
);

CREATE INDEX IF NOT EXISTS idx_stock_batches_item_expiry
  ON stock_batches(stock_item_id, expiry_date NULLS LAST)
  WHERE remaining_qty > 0;


-- 5. ADD stock_item_id TO stock_logs
-- ============================================================
ALTER TABLE stock_logs
  ADD COLUMN IF NOT EXISTS stock_item_id INT REFERENCES stock_items(id);

UPDATE stock_logs sl
SET    stock_item_id = sl.product_id
WHERE  EXISTS (
  SELECT 1 FROM stock_items si WHERE si.id = sl.product_id
);

CREATE INDEX IF NOT EXISTS idx_stock_logs_item
  ON stock_logs(stock_item_id);
