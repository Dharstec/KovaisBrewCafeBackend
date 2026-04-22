-- ============================================================
-- MIGRATION: Packing charges for Zomato / Swiggy
--
-- Global defaults stored in cafe_settings.
-- Per-product overrides in products table.
-- NULL = use global default, 0 = free, >0 = custom charge.
--
-- Run once:
--   psql -d kovais_brew_cafe -f migrations/add_packing_charges.sql
-- ============================================================

-- 1. Per-product packing charges
ALTER TABLE products
  ADD COLUMN IF NOT EXISTS zomato_packing NUMERIC(10,2) DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS swiggy_packing NUMERIC(10,2) DEFAULT NULL;

-- 2. Global settings table
CREATE TABLE IF NOT EXISTS cafe_settings (
  key        VARCHAR(100) PRIMARY KEY,
  value      VARCHAR(500) NOT NULL DEFAULT '0',
  updated_at TIMESTAMP    DEFAULT NOW()
);

-- 3. Insert default global packing charges (edit these via API)
INSERT INTO cafe_settings (key, value) VALUES
  ('zomato_packing_default', '0'),
  ('swiggy_packing_default', '0')
ON CONFLICT (key) DO NOTHING;
