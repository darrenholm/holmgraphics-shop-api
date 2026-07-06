-- 054_sms_log_kind_scoped_dedupe.sql
-- Scope the sms_log dedupe index to the one kind that actually wants
-- once-per-(project, employee) semantics: the automatic 'job-assigned' text.
--
-- The original index (051) covered EVERY kind, which is wrong for the new
-- manual "message the assigned employee" feature (kind 'job-message'):
-- staff can text the same employee about the same job repeatedly, and each
-- successful send must get its own audit row. Without this change the
-- second ok=true insert would violate the index and the log row would be
-- silently dropped (the notifier swallows 23505).
--
-- Safe to re-run.

DROP INDEX IF EXISTS sms_log_job_assigned_idx;

CREATE UNIQUE INDEX IF NOT EXISTS sms_log_job_assigned_idx
  ON sms_log (project_id, employee_id, kind)
  WHERE ok = TRUE AND kind = 'job-assigned';
