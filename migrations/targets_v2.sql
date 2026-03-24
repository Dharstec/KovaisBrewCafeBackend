-- ═════════════════════════════════════════════════════
--  TARGETS V2 MIGRATION — adds sales_target column
--  Run: psql -U postgres -d kovais_brew_cafe -f migrations/targets_v2.sql
-- ═════════════════════════════════════════════════════

ALTER TABLE targets ADD COLUMN IF NOT EXISTS sales_target NUMERIC(10,2) DEFAULT 0;
