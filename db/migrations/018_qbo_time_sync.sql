-- 018_qbo_time_sync.sql
-- Phase 2: QBO TimeActivity sync prerequisites.
--
-- Adds the columns needed to map our local employees (and time entries)
-- to QBO so the "Send to QuickBooks" button on /admin/pay-periods can
-- POST entries to QBO's TimeActivity endpoint.
--
-- Two new columns:
--   employees.qbo_employee_id     — text id of the matching QBO Employee.
--                                   Set once via the /admin/qbo-employees
--                                   mapping page; required before sync runs.
--   time_entries.qbo_time_activity_id — set when an entry is successfully
--                                   POSTed to /v3/.../timeactivity. Acts
--                                   as the idempotency key on retries
--                                   (skip if already populated).
--   time_entries.qbo_synced_at    — timestamp of the successful POST.

ALTER TABLE employees
  ADD COLUMN IF NOT EXISTS qbo_employee_id TEXT;

CREATE INDEX IF NOT EXISTS idx_employees_qbo_employee_id
  ON employees (qbo_employee_id) WHERE qbo_employee_id IS NOT NULL;

ALTER TABLE time_entries
  ADD COLUMN IF NOT EXISTS qbo_time_activity_id TEXT,
  ADD COLUMN IF NOT EXISTS qbo_synced_at        TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS idx_time_entries_qbo_synced
  ON time_entries (qbo_time_activity_id) WHERE qbo_time_activity_id IS NOT NULL;
