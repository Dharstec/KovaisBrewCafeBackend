-- ═══════════════════════════════════════════
--  BUSINESS TARGETS MIGRATION
--  Run: psql -U postgres -d kovais_brew_cafe -f migrations/targets.sql
-- ═══════════════════════════════════════════

CREATE TABLE IF NOT EXISTS targets (
  id         SERIAL PRIMARY KEY,
  name       VARCHAR(100) NOT NULL DEFAULT 'Monthly Target',
  start_date DATE NOT NULL,
  end_date   DATE NOT NULL,
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW()
);

-- Each row = one expense budget item (Deepika, Tamil, Rent, EB, etc.)
CREATE TABLE IF NOT EXISTS target_items (
  id            SERIAL PRIMARY KEY,
  target_id     INTEGER REFERENCES targets(id) ON DELETE CASCADE,
  item_name     VARCHAR(100) NOT NULL,
  target_amount NUMERIC(10,2) NOT NULL DEFAULT 0,
  created_at    TIMESTAMP DEFAULT NOW()
);
