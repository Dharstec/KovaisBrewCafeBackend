-- Add check_in / check_out time columns to attendance
-- Run once: psql -d kovais_brew_cafe -f migrations/attendance_times.sql

ALTER TABLE attendance
  ADD COLUMN IF NOT EXISTS check_in  TIME,
  ADD COLUMN IF NOT EXISTS check_out TIME;
