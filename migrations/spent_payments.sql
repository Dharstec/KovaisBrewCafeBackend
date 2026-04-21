-- ============================================================
-- MIGRATION: spent_payments table (split payment support)
-- One spend record can have multiple partial payments
-- Run once:
--   psql -d kovais_brew_cafe -f migrations/spent_payments.sql
-- ============================================================

-- Remove the single payment_date we added earlier (replaced by this table)
ALTER TABLE spent DROP COLUMN IF EXISTS payment_date;

CREATE TABLE IF NOT EXISTS spent_payments (
  id           SERIAL PRIMARY KEY,
  spent_id     INT           NOT NULL REFERENCES spent(id) ON DELETE CASCADE,
  payment_date DATE          NOT NULL DEFAULT CURRENT_DATE,
  amount       NUMERIC(10,2) NOT NULL CHECK (amount > 0),
  payment_mode VARCHAR(20)   NOT NULL DEFAULT 'CASH',
  note         TEXT,
  created_at   TIMESTAMP     DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_spent_payments_spent
  ON spent_payments(spent_id);
