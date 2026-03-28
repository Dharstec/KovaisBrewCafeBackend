-- ======================================================
-- MIGRATION: Enterprise Stock Batches + Expiry Tracking
-- Run once: psql -d kovais_brew_cafe -f migrations/stock_batches.sql
-- ======================================================

-- 1. Fix stock_logs: add missing columns the code already uses
ALTER TABLE stock_logs ADD COLUMN IF NOT EXISTS action       VARCHAR(20);
ALTER TABLE stock_logs ADD COLUMN IF NOT EXISTS reference_id INT;
ALTER TABLE stock_logs ADD COLUMN IF NOT EXISTS note         TEXT;

-- Drop old restrictive CHECK so SALE/USAGE/STOCK_IN/RETURN are valid
ALTER TABLE stock_logs DROP CONSTRAINT IF EXISTS stock_logs_reason_check;

-- 2. stock_batches — one row per received lot / purchase
--    Supports multi-unit: receive in kg/packet/litre, store in base_unit (gm/ml/pcs)
CREATE TABLE IF NOT EXISTS stock_batches (
  id             SERIAL PRIMARY KEY,

  product_id     INT    NOT NULL REFERENCES products(id),

  -- Lot identity
  batch_no       VARCHAR(100),
  supplier       TEXT,
  notes          TEXT,

  -- Dates
  purchase_date  DATE   NOT NULL DEFAULT CURRENT_DATE,
  expiry_date    DATE,                        -- NULL = no expiry (e.g. equipment)

  -- As received by staff  (e.g.  5  kg  /  10 packet)
  received_unit  VARCHAR(20) NOT NULL,        -- kg | packet | litre | gm | ml | pcs
  received_qty   NUMERIC(10,3) NOT NULL,      -- how many of that unit

  -- Stored in product's base_unit  (gm / ml / pcs)
  --   base_qty        = received_qty * conversion_factor
  --   remaining_qty   decreases as stock is consumed
  base_qty       NUMERIC(10,3) NOT NULL,
  remaining_qty  NUMERIC(10,3) NOT NULL,

  cost_price     NUMERIC(10,2) DEFAULT 0,     -- cost per received_unit

  created_at     TIMESTAMP DEFAULT NOW()
);

-- Fast FIFO lookup: oldest expiry first, only non-empty batches
CREATE INDEX IF NOT EXISTS idx_batches_product_expiry
  ON stock_batches(product_id, expiry_date NULLS LAST)
  WHERE remaining_qty > 0;

-- 3. bills — add local_id if somehow missing (was in add_offline_discount.sql)
ALTER TABLE bills ADD COLUMN IF NOT EXISTS local_id VARCHAR(100);
CREATE UNIQUE INDEX IF NOT EXISTS bills_local_id_idx
  ON bills(local_id) WHERE local_id IS NOT NULL;
