-- =========================================================
-- SEED STOCK ITEMS for Shop 1 (matches Excel "Stock Sheet")
-- Run after: multishop.sql + stock_counts.sql
-- Idempotent: re-running won't duplicate (matches by name+shop)
-- =========================================================
BEGIN;

-- 1) Ensure all categories exist for Shop 1
INSERT INTO categories (name, status, shop_id)
SELECT v.name, true, 1
FROM (VALUES
  ('BAKERY'), ('VEGETABLES'), ('DAIRY'),
  ('FRUITS'), ('NON-VEG'), ('OTHERS')
) AS v(name)
WHERE NOT EXISTS (
  SELECT 1 FROM categories c WHERE c.name = v.name AND c.shop_id = 1
);

-- 2) Helper: insert stock item if not present (by name + shop)
-- Columns: name, category, unit_label, min_qty, current_qty
WITH cat AS (
  SELECT id, name FROM categories WHERE shop_id = 1
)
INSERT INTO stock_items
  (name, category_id, base_unit, unit_label, unit_value,
   current_qty, min_qty, is_active, shop_id)
SELECT
  s.name,
  (SELECT id FROM cat WHERE name = s.cat),
  s.unit, s.unit, 1,
  s.current_qty, s.min_qty, true, 1
FROM (VALUES
  -- BAKERY
  ('Wrap 8.5 Inch',  'BAKERY',     'Sheet',  30,  71),
  ('Wrap 12 Inch',   'BAKERY',     'Sheet',  20,  23),
  ('Milk bread',     'BAKERY',     'Packet',  2,   1),
  ('Tea Bun',        'BAKERY',     'Pcs',     2,  16),
  ('Burger Bun',     'BAKERY',     'Pcs',     1,   8),
  ('Garlic Bread',   'BAKERY',     'Packet',  1, 1.5),
  ('Sandwich Bread', 'BAKERY',     'Packet',  2, 1.5),

  -- VEGETABLES
  ('Cabbage',        'VEGETABLES', 'Pcs',     2,   0),
  ('Cucumber',       'VEGETABLES', 'Pcs',     2,   0),
  ('Carrot',         'VEGETABLES', 'Pcs',     5,   4),
  ('Lemon',          'VEGETABLES', 'Pcs',    10,   0),
  ('Capsicum',       'VEGETABLES', 'Pcs',     3,   0),
  ('Lettuce',        'VEGETABLES', 'Pcs',     1,   0),
  ('Tomatto',        'VEGETABLES', 'Pcs',     3,   8),
  ('Onion',          'VEGETABLES', 'Pcs',     5,   0),
  ('Garlic',         'VEGETABLES', 'Pcs',     2,   1),
  ('Minit',          'VEGETABLES', 'Pcs',     0,   0),

  -- DAIRY
  ('Panner',          'DAIRY',     'Box',     1, 1.5),
  ('Cheese Slice',    'DAIRY',     'Box',     1,  38),
  ('Mozzerala Cheese','DAIRY',     'Packet',  1,   2),
  ('Butter',          'DAIRY',     'Box',     1, 1.5),
  ('Cheese Cubes',    'DAIRY',     'Box',     1,  22),
  ('Freash Cream',    'DAIRY',     'Packet',  1, 3.5),
  ('Kitkat',          'DAIRY',     'Pcs',    10,   0),

  -- FRUITS
  ('Apple',           'FRUITS',    'Pcs',     3,   4),
  ('Watermelon',      'FRUITS',    'Pcs',     0,   1),
  ('Pomogranite',     'FRUITS',    'Pcs',     0,   3),
  ('Muskmelon',       'FRUITS',    'Pcs',     0,   3),
  ('mosambi',         'FRUITS',    'Pcs',     0,   3),
  ('Orange',          'FRUITS',    'Pcs',     0,  11),

  -- NON-VEG
  ('Egg',             'NON-VEG',   'Pcs',    30,  64),
  ('Chicken',         'NON-VEG',   'KG',      1, 1.5),

  -- OTHERS
  ('Maggi',           'OTHERS',    'Packet', 20,   8),
  ('Dreak component', 'OTHERS',    'Packet',  1,   2),
  ('Dates',           'OTHERS',    'Packet',  0,   5),
  ('Brownie Mix',     'OTHERS',    'KG',      2,   5),
  ('Red Mix',         'OTHERS',    'KG',      2,   5),
  ('Crispy Mix',      'OTHERS',    'KG',      1,   5)
) AS s(name, cat, unit, min_qty, current_qty)
WHERE NOT EXISTS (
  SELECT 1 FROM stock_items si
  WHERE si.name = s.name AND si.shop_id = 1
);

COMMIT;

-- Verify:
-- SELECT c.name AS category, si.name, si.unit_label, si.min_qty, si.current_qty
-- FROM stock_items si
-- LEFT JOIN categories c ON c.id = si.category_id
-- WHERE si.shop_id = 1
-- ORDER BY c.name, si.name;
