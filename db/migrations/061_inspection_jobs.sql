-- 061_inspection_jobs.sql
-- Scheduled automation for the daily inspection feature (build spec §7),
-- plus the retention marker the archive job writes.
--
-- Why a run ledger instead of just setInterval: the existing background jobs
-- (proof-archive sweep, Ford Pro poll) fire on a period measured from boot,
-- which is fine for "every N minutes" but cannot express "07:00 on a
-- weekday". Railway restarts on every deploy, so a boot-relative timer
-- drifts to whatever time the last deploy happened.
--
-- So the scheduler ticks often and asks "has the 07:00 job for today run
-- yet?". This table is that answer. Claiming a run is an INSERT that either
-- succeeds or hits the primary key, which makes it:
--   * restart-safe   — a deploy at 07:05 still fires today's run, once
--   * replay-safe    — a tick every few minutes cannot re-send the digest
--   * replica-safe   — two API instances race on the INSERT and exactly one
--                      wins, so nobody gets the email twice
--
-- Safe to re-run.

CREATE TABLE IF NOT EXISTS scheduled_job_runs (
  job_name    TEXT NOT NULL,
  -- The period this run covers, in shop-local time, NOT a timestamp:
  -- 'YYYY-MM-DD' for daily, 'YYYY-Www' for weekly, 'YYYY-MM' for monthly.
  -- Uniqueness on this is what makes the claim idempotent.
  run_key     TEXT NOT NULL,
  started_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  finished_at TIMESTAMPTZ,
  ok          BOOLEAN,
  detail      JSONB,
  PRIMARY KEY (job_name, run_key)
);

CREATE INDEX IF NOT EXISTS idx_scheduled_job_runs_recent
  ON scheduled_job_runs (job_name, started_at DESC);

-- ─── Retention ─────────────────────────────────────────────────────────
-- Reports are retained 6 months; a report with a repair against it is a
-- maintenance record and is retained 2 years. Past that the monthly job
-- marks the row archived — it never deletes, and an archived row is still
-- readable by id, it just drops out of the default listings.
ALTER TABLE inspections
  ADD COLUMN IF NOT EXISTS archived_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS idx_inspections_unarchived
  ON inspections (completed_at DESC) WHERE archived_at IS NULL;

-- The immutability trigger (migration 060) compares whole rows with only
-- the legitimately-mutable keys subtracted, which means a column added
-- afterwards is frozen by default. That is the behaviour we want — but it
-- also means archived_at could never be set, so the retention job would
-- fail against its own safety net. Teach the lock about it.
--
-- archived_at is bookkeeping, not content: it changes nothing an officer or
-- an auditor reads off the report.
CREATE OR REPLACE FUNCTION lock_completed_inspection() RETURNS TRIGGER AS $$
BEGIN
  IF OLD.completed_at IS NULL THEN
    RETURN NEW;
  END IF;

  IF (to_jsonb(NEW) - 'status' - 'submitted_at' - 'deleted_at' - 'archived_at')
     IS DISTINCT FROM
     (to_jsonb(OLD) - 'status' - 'submitted_at' - 'deleted_at' - 'archived_at') THEN
    RAISE EXCEPTION
      'Completed inspection % is immutable (O. Reg. 199/07 record). Supersede it with a new report instead.',
      OLD.id
      USING ERRCODE = 'restrict_violation';
  END IF;

  IF NEW.status IS DISTINCT FROM OLD.status AND NEW.status <> 'superseded' THEN
    RAISE EXCEPTION
      'Completed inspection % may only be superseded, not moved to %.',
      OLD.id, NEW.status
      USING ERRCODE = 'restrict_violation';
  END IF;

  IF OLD.submitted_at IS NOT NULL AND NEW.submitted_at IS DISTINCT FROM OLD.submitted_at THEN
    RAISE EXCEPTION 'submitted_at on inspection % is write-once.', OLD.id
      USING ERRCODE = 'restrict_violation';
  END IF;

  IF OLD.deleted_at IS NOT NULL AND NEW.deleted_at IS DISTINCT FROM OLD.deleted_at THEN
    RAISE EXCEPTION 'deleted_at on inspection % is write-once.', OLD.id
      USING ERRCODE = 'restrict_violation';
  END IF;

  -- Un-archiving is allowed (someone pulled a record back for an audit);
  -- what is not allowed is archiving as a way to make a report disappear,
  -- which is why there is no delete path at all.
  RETURN NEW;
END $$ LANGUAGE plpgsql;
