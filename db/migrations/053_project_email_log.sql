-- 053_project_email_log.sql
-- Let email_log record project-level sends (not just online orders), so the
-- staff "notify ready for pickup" button on the job card can log the email it
-- sends for a project that has no online order behind it.
--
--   * order_id becomes nullable (project sends have no order).
--   * project_id added (nullable; set for project-level sends).
--
-- Existing order sends are unaffected: they still set order_id and the
-- order/kind unique index still guards them. Project sends set project_id
-- with order_id NULL — deliberately NOT deduped, since the pickup notice is a
-- manual button staff may legitimately re-send.
--
-- Safe to re-run.

ALTER TABLE email_log
  ALTER COLUMN order_id DROP NOT NULL;

ALTER TABLE email_log
  ADD COLUMN IF NOT EXISTS project_id INT REFERENCES projects(id) ON DELETE CASCADE;

CREATE INDEX IF NOT EXISTS email_log_project_idx
  ON email_log (project_id, sent_at DESC);
