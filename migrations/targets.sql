CREATE TABLE IF NOT EXISTS targets (
  id SERIAL PRIMARY KEY,
  name VARCHAR(100) NOT NULL DEFAULT 'Monthly Target',
  start_date DATE NOT NULL,
  end_date DATE NOT NULL,
  room_rent_target NUMERIC(10,2) DEFAULT 0,
  eb_target NUMERIC(10,2) DEFAULT 0,
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS target_items (
  id SERIAL PRIMARY KEY,
  target_id INTEGER REFERENCES targets(id) ON DELETE CASCADE,
  item_name VARCHAR(100) NOT NULL,
  target_amount NUMERIC(10,2) NOT NULL DEFAULT 0,
  created_at TIMESTAMP DEFAULT NOW()
);
