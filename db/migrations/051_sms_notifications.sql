-- 051_sms_notifications.sql
-- SMS notifications, phase 1: text the employee assigned to a job.
--
-- Two changes:
--   1. employees.phone_number — the mobile number we text. NULL for any
--      employee we don't (or can't) text; the notifier skips those.
--   2. sms_log — idempotency + audit log for outbound SMS, mirroring
--      email_log (see 010_email_log.sql). Deliberately generic so the
--      later "notify the client" phase reuses the same table: recipient is
--      whichever of employee_id / client_id is set, and the send can be
--      tied to a project and/or an order.
--
-- Provider-agnostic: message_id holds whatever id the active provider
-- returns (SkySwitch ref_id / message id, or Twilio SID if we ever swap).
--
-- Safe to re-run.

-- ─── 1. employees.phone_number ───────────────────────────────────────────────
ALTER TABLE employees
  ADD COLUMN IF NOT EXISTS phone_number TEXT;

-- ─── 2. sms_log ──────────────────────────────────────────────────────────────
-- One row per send attempt. ok=true means the provider accepted the message
-- (or the notifier ran in stub mode with no credentials configured). ok=false
-- captures failures so they can be retried by clearing the row.
--
-- Recipient columns are both nullable: staff notifications set employee_id,
-- the future client notifications will set client_id. project_id / order_id
-- give the send its business context and drive idempotency.
CREATE TABLE IF NOT EXISTS sms_log (
  id           SERIAL PRIMARY KEY,
  kind         TEXT NOT NULL,            -- e.g. 'job-assigned'
  employee_id  INT REFERENCES employees(id) ON DELETE SET NULL,
  client_id    INT REFERENCES clients(id)   ON DELETE SET NULL,
  project_id   INT REFERENCES projects(id)  ON DELETE CASCADE,
  order_id     INT REFERENCES orders(id)    ON DELETE CASCADE,
  to_number    TEXT,                     -- the destination we actually dialed
  provider     TEXT,                     -- 'skyswitch' | 'twilio' | 'stub'
  ok           BOOLEAN NOT NULL,
  message_id   TEXT,                     -- provider's id, when ok=true
  error        TEXT,                     -- failure detail, when ok=false
  sent_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Idempotency for job-assignment texts: an employee is texted at most once
-- per (project, employee) pair. Reassigning a job to someone new sends a
-- fresh text (new employee_id); bouncing it back to a prior assignee does
-- not re-text them (their ok=true row already exists). Failures (ok=false)
-- are excluded so a transient provider error can be retried.
CREATE UNIQUE INDEX IF NOT EXISTS sms_log_job_assigned_idx
  ON sms_log (project_id, employee_id, kind)
  WHERE ok = TRUE;

CREATE INDEX IF NOT EXISTS sms_log_project_idx
  ON sms_log (project_id, sent_at DESC);
