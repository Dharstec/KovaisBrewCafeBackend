-- Add Zomato/Swiggy prices to products
ALTER TABLE products ADD COLUMN IF NOT EXISTS zomato_price DECIMAL(10,2) DEFAULT NULL;
ALTER TABLE products ADD COLUMN IF NOT EXISTS swiggy_price DECIMAL(10,2) DEFAULT NULL;

-- Tag bills with the platform they came from
ALTER TABLE bills ADD COLUMN IF NOT EXISTS platform VARCHAR(20) DEFAULT NULL;
