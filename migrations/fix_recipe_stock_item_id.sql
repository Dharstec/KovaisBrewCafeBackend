-- ============================================================
-- FIX: product_recipes rows where stock_item_id is NULL
--
-- Before the stock_items migration, raw_product_id pointed at
-- the products table.  After migration, products that had
-- track_stock=true were copied to stock_items WITH THE SAME IDs.
-- So raw_product_id == stock_item_id for those rows.
--
-- This one-time fix populates the empty stock_item_id column.
-- Run:
--   psql -d kovais_brew_cafe -f migrations/fix_recipe_stock_item_id.sql
-- ============================================================

UPDATE product_recipes
SET    stock_item_id = raw_product_id
WHERE  stock_item_id IS NULL
  AND  raw_product_id IS NOT NULL
  AND  EXISTS (
         SELECT 1 FROM stock_items si WHERE si.id = raw_product_id
       );

-- Confirm result
SELECT
  COUNT(*)                                        AS total_rows,
  COUNT(*) FILTER (WHERE stock_item_id IS NULL)   AS still_null,
  COUNT(*) FILTER (WHERE stock_item_id IS NOT NULL) AS fixed
FROM product_recipes;
