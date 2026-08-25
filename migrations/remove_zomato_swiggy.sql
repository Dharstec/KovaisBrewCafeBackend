-- ============================================================
-- MIGRATION: remove_zomato_swiggy.sql
--
-- Removes the Zomato/Swiggy delivery-platform concept entirely:
-- platform-specific pricing, packing charges, and bill tagging.
-- Add-ons (product_addons) are kept as a general feature, just
-- with the platform column dropped since every add-on now applies
-- to all orders.
--
-- Take a backup first:
--   pg_dump -U postgres kovais_brew_cafe > backup_pre_zomato_removal.sql
-- ============================================================

BEGIN;

ALTER TABLE products DROP COLUMN IF EXISTS zomato_price;
ALTER TABLE products DROP COLUMN IF EXISTS swiggy_price;
ALTER TABLE products DROP COLUMN IF EXISTS zomato_packing;
ALTER TABLE products DROP COLUMN IF EXISTS swiggy_packing;

ALTER TABLE bills DROP COLUMN IF EXISTS platform;

ALTER TABLE product_addons DROP COLUMN IF EXISTS platform;

DROP TABLE IF EXISTS cafe_settings;

COMMIT;
