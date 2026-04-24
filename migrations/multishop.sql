-- ============================================================
-- MIGRATION: multishop.sql
-- Adds Shop 1 / Shop 2 multi-tenancy to the whole application.
--
-- Safe to run ONCE.  Uses IF NOT EXISTS / IF EXISTS guards so
-- re-running won't explode, but take a backup first:
--
--   pg_dump -U postgres kovais_brew_cafe > backup_pre_multishop.sql
--   psql   -U postgres -d kovais_brew_cafe -f migrations/multishop.sql
--
-- What this does:
--   1. Creates `shops` table and inserts Shop 1 + Shop 2
--   2. Adds `shop_id` to every per-shop table
--   3. Backfills every existing row with shop_id = 1  (Shop 1)
--   4. Makes shop_id NOT NULL afterwards
--   5. Adds indexes for shop-scoped queries
--
-- Users:
--   - existing Admin rows  -> shop_id stays NULL (means: all shops)
--   - existing non-admin   -> shop_id = 1
-- ============================================================

BEGIN;

-- ------------------------------------------------------------
-- 1. shops master table
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS shops (
  id         SERIAL PRIMARY KEY,
  name       VARCHAR(100) NOT NULL,
  code       VARCHAR(20)  UNIQUE,
  address    TEXT,
  is_active  BOOLEAN      NOT NULL DEFAULT TRUE,
  created_at TIMESTAMP    DEFAULT NOW()
);

INSERT INTO shops (id, name, code)
VALUES (1, 'Shop 1', 'SHOP1'), (2, 'Shop 2', 'SHOP2')
ON CONFLICT (id) DO NOTHING;

-- keep the serial sequence in sync after explicit ids
SELECT setval(pg_get_serial_sequence('shops','id'),
              GREATEST((SELECT MAX(id) FROM shops), 1));

-- ------------------------------------------------------------
-- 2. Helper: add shop_id column + backfill + NOT NULL + index
-- ------------------------------------------------------------
-- We repeat the same 4-step pattern per table.
-- If a table doesn't exist in this DB, its block is skipped.

-- ----- users (shared, shop_id NULL means admin/all-shops) -----
DO $$ BEGIN
  IF to_regclass('public.users') IS NOT NULL THEN
    ALTER TABLE users ADD COLUMN IF NOT EXISTS shop_id INT REFERENCES shops(id);
    -- Non-admin rows -> shop 1.  Admins (role name = 'Admin') -> stay NULL.
    UPDATE users u SET shop_id = 1
      WHERE shop_id IS NULL
        AND role_id IN (SELECT id FROM roles WHERE LOWER(role_type) <> 'admin');
    CREATE INDEX IF NOT EXISTS idx_users_shop ON users(shop_id);
  END IF;
END $$;

-- ----- products -----
ALTER TABLE products        ADD COLUMN IF NOT EXISTS shop_id INT REFERENCES shops(id);
UPDATE    products        SET shop_id = 1 WHERE shop_id IS NULL;
ALTER TABLE products        ALTER COLUMN shop_id SET NOT NULL;
CREATE INDEX IF NOT EXISTS idx_products_shop ON products(shop_id);

-- ----- categories -----
ALTER TABLE categories      ADD COLUMN IF NOT EXISTS shop_id INT REFERENCES shops(id);
UPDATE    categories      SET shop_id = 1 WHERE shop_id IS NULL;
ALTER TABLE categories      ALTER COLUMN shop_id SET NOT NULL;
CREATE INDEX IF NOT EXISTS idx_categories_shop ON categories(shop_id);

-- ----- product_recipes (inherits shop via products; add column for fast filter) -----
DO $$ BEGIN
  IF to_regclass('public.product_recipes') IS NOT NULL THEN
    ALTER TABLE product_recipes ADD COLUMN IF NOT EXISTS shop_id INT REFERENCES shops(id);
    UPDATE product_recipes pr
      SET shop_id = COALESCE(
        (SELECT p.shop_id FROM products p WHERE p.id = pr.sale_product_id),
        1
      )
      WHERE pr.shop_id IS NULL;
    ALTER TABLE product_recipes ALTER COLUMN shop_id SET NOT NULL;
    CREATE INDEX IF NOT EXISTS idx_product_recipes_shop ON product_recipes(shop_id);
  END IF;
END $$;

-- ----- stock_items -----
ALTER TABLE stock_items     ADD COLUMN IF NOT EXISTS shop_id INT REFERENCES shops(id);
UPDATE    stock_items     SET shop_id = 1 WHERE shop_id IS NULL;
ALTER TABLE stock_items     ALTER COLUMN shop_id SET NOT NULL;
CREATE INDEX IF NOT EXISTS idx_stock_items_shop ON stock_items(shop_id);

-- ----- stock_entries -----
ALTER TABLE stock_entries   ADD COLUMN IF NOT EXISTS shop_id INT REFERENCES shops(id);
UPDATE    stock_entries   SET shop_id = 1 WHERE shop_id IS NULL;
ALTER TABLE stock_entries   ALTER COLUMN shop_id SET NOT NULL;
CREATE INDEX IF NOT EXISTS idx_stock_entries_shop ON stock_entries(shop_id);

-- ----- stock_logs -----
ALTER TABLE stock_logs      ADD COLUMN IF NOT EXISTS shop_id INT REFERENCES shops(id);
UPDATE    stock_logs      SET shop_id = 1 WHERE shop_id IS NULL;
ALTER TABLE stock_logs      ALTER COLUMN shop_id SET NOT NULL;
CREATE INDEX IF NOT EXISTS idx_stock_logs_shop ON stock_logs(shop_id);

-- ----- bills -----
ALTER TABLE bills           ADD COLUMN IF NOT EXISTS shop_id INT REFERENCES shops(id);
UPDATE    bills           SET shop_id = 1 WHERE shop_id IS NULL;
ALTER TABLE bills           ALTER COLUMN shop_id SET NOT NULL;
CREATE INDEX IF NOT EXISTS idx_bills_shop          ON bills(shop_id);
CREATE INDEX IF NOT EXISTS idx_bills_shop_created  ON bills(shop_id, created_at DESC);

-- ----- bill_items -----
ALTER TABLE bill_items      ADD COLUMN IF NOT EXISTS shop_id INT REFERENCES shops(id);
UPDATE    bill_items      SET shop_id = 1 WHERE shop_id IS NULL;
ALTER TABLE bill_items      ALTER COLUMN shop_id SET NOT NULL;
CREATE INDEX IF NOT EXISTS idx_bill_items_shop ON bill_items(shop_id);

-- ----- coupons -----
DO $$ BEGIN
  IF to_regclass('public.coupons') IS NOT NULL THEN
    ALTER TABLE coupons ADD COLUMN IF NOT EXISTS shop_id INT REFERENCES shops(id);
    UPDATE coupons SET shop_id = 1 WHERE shop_id IS NULL;
    ALTER TABLE coupons ALTER COLUMN shop_id SET NOT NULL;
    CREATE INDEX IF NOT EXISTS idx_coupons_shop ON coupons(shop_id);
  END IF;
END $$;

-- ----- cafe_settings (per-shop settings incl. packing charges) -----
DO $$ BEGIN
  IF to_regclass('public.cafe_settings') IS NOT NULL THEN
    ALTER TABLE cafe_settings ADD COLUMN IF NOT EXISTS shop_id INT REFERENCES shops(id);
    UPDATE cafe_settings SET shop_id = 1 WHERE shop_id IS NULL;
    ALTER TABLE cafe_settings ALTER COLUMN shop_id SET NOT NULL;
    -- (key) was likely unique; make it unique per shop instead.
    ALTER TABLE cafe_settings DROP CONSTRAINT IF EXISTS cafe_settings_key_key;
    CREATE UNIQUE INDEX IF NOT EXISTS idx_cafe_settings_shop_key
      ON cafe_settings(shop_id, key);
  END IF;
END $$;

-- ----- spent (expenses) -----
DO $$ BEGIN
  IF to_regclass('public.spent') IS NOT NULL THEN
    ALTER TABLE spent ADD COLUMN IF NOT EXISTS shop_id INT REFERENCES shops(id);
    UPDATE spent SET shop_id = 1 WHERE shop_id IS NULL;
    ALTER TABLE spent ALTER COLUMN shop_id SET NOT NULL;
    CREATE INDEX IF NOT EXISTS idx_spent_shop ON spent(shop_id);
  END IF;
END $$;

-- ----- spent_payments -----
DO $$ BEGIN
  IF to_regclass('public.spent_payments') IS NOT NULL THEN
    ALTER TABLE spent_payments ADD COLUMN IF NOT EXISTS shop_id INT REFERENCES shops(id);
    UPDATE spent_payments sp
      SET shop_id = COALESCE((SELECT s.shop_id FROM spent s WHERE s.id = sp.spent_id), 1)
      WHERE sp.shop_id IS NULL;
    ALTER TABLE spent_payments ALTER COLUMN shop_id SET NOT NULL;
    CREATE INDEX IF NOT EXISTS idx_spent_payments_shop ON spent_payments(shop_id);
  END IF;
END $$;

-- ----- employees -----
DO $$ BEGIN
  IF to_regclass('public.employees') IS NOT NULL THEN
    ALTER TABLE employees ADD COLUMN IF NOT EXISTS shop_id INT REFERENCES shops(id);
    UPDATE employees SET shop_id = 1 WHERE shop_id IS NULL;
    ALTER TABLE employees ALTER COLUMN shop_id SET NOT NULL;
    CREATE INDEX IF NOT EXISTS idx_employees_shop ON employees(shop_id);
  END IF;
END $$;

-- ----- employee_advance -----
DO $$ BEGIN
  IF to_regclass('public.employee_advance') IS NOT NULL THEN
    ALTER TABLE employee_advance ADD COLUMN IF NOT EXISTS shop_id INT REFERENCES shops(id);
    UPDATE employee_advance ea
      SET shop_id = COALESCE((SELECT e.shop_id FROM employees e WHERE e.id = ea.employee_id), 1)
      WHERE ea.shop_id IS NULL;
    ALTER TABLE employee_advance ALTER COLUMN shop_id SET NOT NULL;
    CREATE INDEX IF NOT EXISTS idx_employee_advance_shop ON employee_advance(shop_id);
  END IF;
END $$;

-- ----- attendance -----
DO $$ BEGIN
  IF to_regclass('public.attendance') IS NOT NULL THEN
    ALTER TABLE attendance ADD COLUMN IF NOT EXISTS shop_id INT REFERENCES shops(id);
    UPDATE attendance a
      SET shop_id = COALESCE((SELECT e.shop_id FROM employees e WHERE e.id = a.employee_id), 1)
      WHERE a.shop_id IS NULL;
    ALTER TABLE attendance ALTER COLUMN shop_id SET NOT NULL;
    CREATE INDEX IF NOT EXISTS idx_attendance_shop ON attendance(shop_id);
  END IF;
END $$;

-- ----- salary_records -----
DO $$ BEGIN
  IF to_regclass('public.salary_records') IS NOT NULL THEN
    ALTER TABLE salary_records ADD COLUMN IF NOT EXISTS shop_id INT REFERENCES shops(id);
    UPDATE salary_records sr
      SET shop_id = COALESCE((SELECT e.shop_id FROM employees e WHERE e.id = sr.employee_id), 1)
      WHERE sr.shop_id IS NULL;
    ALTER TABLE salary_records ALTER COLUMN shop_id SET NOT NULL;
    CREATE INDEX IF NOT EXISTS idx_salary_records_shop ON salary_records(shop_id);
  END IF;
END $$;

-- ----- targets -----
DO $$ BEGIN
  IF to_regclass('public.targets') IS NOT NULL THEN
    ALTER TABLE targets ADD COLUMN IF NOT EXISTS shop_id INT REFERENCES shops(id);
    UPDATE targets SET shop_id = 1 WHERE shop_id IS NULL;
    ALTER TABLE targets ALTER COLUMN shop_id SET NOT NULL;
    CREATE INDEX IF NOT EXISTS idx_targets_shop ON targets(shop_id);
  END IF;
END $$;

COMMIT;

-- ============================================================
-- Sanity checks (run manually after migration):
--   SELECT id, name FROM shops;
--   SELECT shop_id, COUNT(*) FROM bills         GROUP BY shop_id;
--   SELECT shop_id, COUNT(*) FROM products      GROUP BY shop_id;
--   SELECT shop_id, COUNT(*) FROM stock_items   GROUP BY shop_id;
--   SELECT shop_id, COUNT(*) FROM users         GROUP BY shop_id;
-- Expected: every row belongs to shop_id = 1
--           (users may have NULLs — that's admins = all-shop)
-- ============================================================
