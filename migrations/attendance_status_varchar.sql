-- Fix status column to support 2-char codes (HL = Holiday)
-- Run once: psql -d kovais_brew_cafe -f migrations/attendance_status_varchar.sql

ALTER TABLE attendance ALTER COLUMN status TYPE VARCHAR(2);
