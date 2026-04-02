-- Enterprise attendance statuses migration
-- Run once: psql -d kovais_brew_cafe -f migrations/attendance_statuses.sql

-- 1. Add check_in / check_out columns (safe to re-run)
ALTER TABLE attendance
  ADD COLUMN IF NOT EXISTS check_in  TIME,
  ADD COLUMN IF NOT EXISTS check_out TIME;

-- 2. Drop old constraint and add new one allowing all 6 statuses
ALTER TABLE attendance DROP CONSTRAINT IF EXISTS attendance_status_check;
ALTER TABLE attendance
  ADD CONSTRAINT attendance_status_check
  CHECK (status IN ('P', 'A', 'H', 'L', 'HL'));

-- Status meanings:
--   P  = Present
--   A  = Absent
--   H  = Half Day
--   L  = Late
--   HL = Holiday  (public / festival holiday)
