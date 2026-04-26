-- Daily night stock count (cashier fills, admin reviews)
BEGIN;

CREATE TABLE IF NOT EXISTS stock_counts (
  id            SERIAL PRIMARY KEY,
  shop_id       INT  NOT NULL REFERENCES shops(id),
  stock_item_id INT  NOT NULL REFERENCES stock_items(id),
  count_date    DATE NOT NULL,
  opening_qty   NUMERIC(12,2) NOT NULL DEFAULT 0,
  closing_qty   NUMERIC(12,2) NOT NULL DEFAULT 0,
  variance      NUMERIC(12,2) NOT NULL DEFAULT 0,
  counted_by    INT,        -- users.id of cashier
  locked        BOOLEAN NOT NULL DEFAULT true,
  note          TEXT,
  created_at    TIMESTAMPTZ DEFAULT NOW(),
  updated_at    TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE (shop_id, stock_item_id, count_date)
);

CREATE INDEX IF NOT EXISTS idx_stock_counts_date ON stock_counts(shop_id, count_date);

COMMIT;
