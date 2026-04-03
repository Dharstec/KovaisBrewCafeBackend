-- Salary records table
-- Run once: psql -d kovais_brew_cafe -f migrations/salary.sql

CREATE TABLE IF NOT EXISTS salary_records (
  id               SERIAL PRIMARY KEY,
  employee_id      INT REFERENCES employees(id),
  month            CHAR(7) NOT NULL,          -- "2026-03"
  base_salary      NUMERIC(10,2) NOT NULL,
  total_days       INT NOT NULL,              -- calendar days in month
  present_days     NUMERIC(5,2) NOT NULL,     -- P + L + H×0.5
  absent_days      INT NOT NULL,
  half_days        INT NOT NULL,
  holiday_days     INT NOT NULL,              -- HL (paid)
  late_days        INT NOT NULL,
  daily_rate       NUMERIC(10,2) NOT NULL,
  absent_deduction NUMERIC(10,2) NOT NULL DEFAULT 0,
  half_deduction   NUMERIC(10,2) NOT NULL DEFAULT 0,
  advance_deduction NUMERIC(10,2) NOT NULL DEFAULT 0,
  net_payable      NUMERIC(10,2) NOT NULL,
  finalized        BOOLEAN DEFAULT false,
  finalized_at     TIMESTAMPTZ,
  created_at       TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(employee_id, month)
);
