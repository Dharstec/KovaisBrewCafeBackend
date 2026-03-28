-- ============================================================
-- MIGRATION: stock_entries table
-- Tracks every purchase separately with price + expiry
--
-- Run once:
--   psql -d kovais_brew_cafe -f migrations/stock_entries.sql
-- ============================================================

-- stock_entries: one row per purchase
-- Every time you buy sugar, milk, coffee powder etc.
-- you create one entry with qty, price, expiry date
-- This lets you track price changes over time
CREATE TABLE IF NOT EXISTS stock_entries (
  id             SERIAL PRIMARY KEY,

  stock_item_id  INT    NOT NULL REFERENCES stock_items(id),

  -- Purchase details
  qty            NUMERIC(10,3) NOT NULL,   -- in item's unit_label  (e.g. 5 kg)
  unit           VARCHAR(20)   NOT NULL,   -- unit_label at time of purchase

  -- Stored in base_unit for deduction maths
  base_qty       NUMERIC(10,3) NOT NULL,   -- qty * unit_value  (e.g. 5000 gm)
  remaining_qty  NUMERIC(10,3) NOT NULL,   -- decreases as stock is consumed

  purchase_price NUMERIC(10,2) NOT NULL DEFAULT 0,  -- price per unit (e.g. ₹45 per kg)
  purchase_date  DATE          NOT NULL DEFAULT CURRENT_DATE,
  expiry_date    DATE,                     -- NULL = no expiry

  supplier       VARCHAR(200),
  batch_no       VARCHAR(100),
  notes          TEXT,

  created_at     TIMESTAMP DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_stock_entries_item
  ON stock_entries(stock_item_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_stock_entries_expiry
  ON stock_entries(stock_item_id, expiry_date NULLS LAST)
  WHERE remaining_qty > 0;

-- Migrate existing stock_batches data → stock_entries
INSERT INTO stock_entries
  (stock_item_id, qty, unit, base_qty, remaining_qty,
   purchase_price, purchase_date, expiry_date,
   supplier, batch_no, notes, created_at)
SELECT
  stock_item_id,
  received_qty,
  received_unit,
  base_qty,
  remaining_qty,
  COALESCE(cost_price, 0),
  COALESCE(purchase_date, CURRENT_DATE),
  expiry_date,
  supplier,
  batch_no,
  notes,
  created_at
FROM stock_batches
WHERE stock_item_id IS NOT NULL
ON CONFLICT DO NOTHING;

-- Update stock_logs to reference stock_entries
ALTER TABLE stock_logs
  ADD COLUMN IF NOT EXISTS stock_entry_id INT REFERENCES stock_entries(id);
