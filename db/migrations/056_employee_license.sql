-- 056_employee_license.sql
-- Driver's license image on the employee record. The file itself lives on
-- the fleet Railway Volume (lib/fleet-storage.js, under _staff/<emp_id>/),
-- NEVER served by URL — only through the admin-gated streaming endpoint
-- GET /api/employees/:id/license. One current license per employee;
-- replacing deletes the old file.
--
-- Safe to re-run.

ALTER TABLE employees
  ADD COLUMN IF NOT EXISTS license_file_path  TEXT,
  ADD COLUMN IF NOT EXISTS license_file_mime  TEXT,
  ADD COLUMN IF NOT EXISTS license_uploaded_at TIMESTAMPTZ;
