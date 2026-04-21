-- ============================================================
-- MIGRATION: Add payment_date to spent table
-- date         = when the purchase/expense was incurred
-- payment_date = when the payment was actually made (can differ)
-- Run once:
--   psql -d kovais_brew_cafe -f migrations/spend_payment_date.sql
-- ============================================================

ALTER TABLE spent
  ADD COLUMN IF NOT EXISTS payment_date DATE;
