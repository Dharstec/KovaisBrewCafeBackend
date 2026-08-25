-- ============================================================
-- MIGRATION: fix_missing_shop_id_columns.sql
--
-- Found while rebuilding a local test database from this repo's
-- schema + migrations/ history: cafe_settings, salary_records,
-- spent_payments, stock_entries, and targets never received the
-- shop_id column that migrations/multishop.sql adds to every other
-- per-shop table. If the live server's migration history has the
-- same gap, these tables are effectively un-scoped by shop right
-- now (targets, salary finalization, spend payment tracking, stock
-- purchase entries, cafe settings).
--
-- Safe to run on a server that already has these columns - every
-- statement is a guarded no-op in that case.
--
-- Take a backup first:
--   pg_dump -U postgres kovais_brew_cafe > backup_pre_shopid_fix.sql
-- ============================================================

BEGIN;

ALTER TABLE cafe_settings  ADD COLUMN IF NOT EXISTS shop_id INT REFERENCES shops(id);
UPDATE      cafe_settings  SET shop_id = 1 WHERE shop_id IS NULL;

ALTER TABLE salary_records ADD COLUMN IF NOT EXISTS shop_id INT REFERENCES shops(id);
UPDATE      salary_records SET shop_id = 1 WHERE shop_id IS NULL;

ALTER TABLE spent_payments ADD COLUMN IF NOT EXISTS shop_id INT REFERENCES shops(id);
UPDATE      spent_payments SET shop_id = 1 WHERE shop_id IS NULL;

ALTER TABLE stock_entries  ADD COLUMN IF NOT EXISTS shop_id INT REFERENCES shops(id);
UPDATE      stock_entries  SET shop_id = 1 WHERE shop_id IS NULL;

ALTER TABLE targets        ADD COLUMN IF NOT EXISTS shop_id INT REFERENCES shops(id);
UPDATE      targets        SET shop_id = 1 WHERE shop_id IS NULL;

COMMIT;

-- Verify afterwards:
--   SELECT table_name FROM information_schema.columns
--   WHERE column_name = 'shop_id' AND table_schema = 'public'
--   ORDER BY table_name;
