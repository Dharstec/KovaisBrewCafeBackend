-- ============================================================
-- FIX: Backfill product_recipes.stock_item_id from raw_product_id
-- Run once after stock_items migration.
-- Safe to re-run (only updates rows where stock_item_id IS NULL).
-- ============================================================
UPDATE product_recipes
SET    stock_item_id = raw_product_id
WHERE  stock_item_id IS NULL
  AND  raw_product_id IS NOT NULL
  AND  EXISTS (
         SELECT 1 FROM stock_items si WHERE si.id = raw_product_id
       );

-- Verify
SELECT
  COUNT(*)                                           AS total_rows,
  COUNT(*) FILTER (WHERE stock_item_id IS NULL)      AS still_null,
  COUNT(*) FILTER (WHERE stock_item_id IS NOT NULL)  AS fixed
FROM product_recipes;
