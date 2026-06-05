-- Split payment: store individual cash and UPI amounts on a bill
-- payment_mode = 'SPLIT' when the customer pays partly in cash and partly via UPI
ALTER TABLE bills
  ADD COLUMN IF NOT EXISTS cash_amount NUMERIC(10,2) DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS upi_amount  NUMERIC(10,2) DEFAULT NULL;
