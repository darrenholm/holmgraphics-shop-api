-- 017_pay_periods.sql
-- Pay period as a first-class entity for the time-tracking module.
--
-- Each time_entry belongs to a pay period via pay_period_id, auto-assigned by
-- a trigger from clock_in's date. The export workflow now operates on a
-- period (not an arbitrary date range), so "did I already export this?"
-- becomes a structural truth instead of relying on per-entry flags.
--
-- Anchor (provided by Darren): Thu Apr 30, 2026 → Wed May 13, 2026 is the
-- pay period in progress at migration time. Cycle length: 14 days. Pay date:
-- end_date + 5 days (so a Wed end-of-period pays out on the following Mon).
--
-- Period status: open (entries assignable) → closed (no new edits) → exported
-- (CSV/QBO sent for payroll).

CREATE TABLE IF NOT EXISTS pay_periods (
  id              SERIAL PRIMARY KEY,
  start_date      DATE NOT NULL,
  end_date        DATE NOT NULL,
  pay_date        DATE NOT NULL,
  status          TEXT NOT NULL DEFAULT 'open'
                  CHECK (status IN ('open', 'closed', 'exported')),
  exported_at     TIMESTAMPTZ,
  exported_by     INTEGER REFERENCES employees(id),
  csv_filename    TEXT,
  exported_count  INTEGER,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT end_after_start CHECK (end_date > start_date),
  CONSTRAINT pay_after_end   CHECK (pay_date >= end_date)
);

-- start_date is the natural unique key — two periods can't start the same day.
CREATE UNIQUE INDEX IF NOT EXISTS uniq_pay_periods_start ON pay_periods (start_date);
CREATE INDEX IF NOT EXISTS idx_pay_periods_dates ON pay_periods (start_date, end_date);

-- Auto-bump updated_at on UPDATE (matches the clients/time_entries pattern).
CREATE OR REPLACE FUNCTION pay_periods_set_updated_at()
RETURNS TRIGGER AS $$
BEGIN NEW.updated_at := NOW(); RETURN NEW; END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS pay_periods_updated_at_trigger ON pay_periods;
CREATE TRIGGER pay_periods_updated_at_trigger
  BEFORE UPDATE ON pay_periods FOR EACH ROW
  EXECUTE FUNCTION pay_periods_set_updated_at();

-- ───────────────────────────────────────────────────────────────────────────
-- Seed the initial 13 periods: 8 backward + current + 4 forward.
-- 8 backward gives ~16 weeks of historical attribution for any old time
-- entries (Phase 1 smoke-test entries get assigned correctly via the backfill
-- below). 4 forward keeps the trigger from missing-target-period failures
-- for the next ~2 months; admins call POST /admin/extend to add more.
-- ───────────────────────────────────────────────────────────────────────────
DO $$
DECLARE
  anchor DATE := '2026-04-30';   -- Thu, current period at migration time
  i INT;
  s DATE; e DATE; p DATE;
BEGIN
  FOR i IN -8..4 LOOP
    s := anchor + (i * 14);   -- Thu, every 14 days from anchor
    e := s + 13;              -- Wed, 13 days after start
    p := e + 5;               -- Mon, 5 days after end
    INSERT INTO pay_periods (start_date, end_date, pay_date, status)
    VALUES (s, e, p, 'open')
    ON CONFLICT (start_date) DO NOTHING;
  END LOOP;
END $$;

-- ───────────────────────────────────────────────────────────────────────────
-- Hook pay_periods into time_entries.
-- ───────────────────────────────────────────────────────────────────────────

ALTER TABLE time_entries
  ADD COLUMN IF NOT EXISTS pay_period_id INTEGER REFERENCES pay_periods(id);

CREATE INDEX IF NOT EXISTS idx_time_entries_pay_period
  ON time_entries (pay_period_id) WHERE pay_period_id IS NOT NULL;

-- Helper: which pay period contains this date? Returns NULL if none — caller
-- should call POST /api/pay-periods/admin/extend to seed more.
CREATE OR REPLACE FUNCTION pay_period_for_date(d DATE)
RETURNS INTEGER AS $$
  SELECT id FROM pay_periods
   WHERE d >= start_date AND d <= end_date
   LIMIT 1;
$$ LANGUAGE sql STABLE;

-- Auto-assign pay_period_id whenever a time_entry is inserted, or whenever
-- its clock_in is later edited (admin correcting a forgotten punch).
CREATE OR REPLACE FUNCTION time_entries_set_pay_period()
RETURNS TRIGGER AS $$
BEGIN
  NEW.pay_period_id := pay_period_for_date(NEW.clock_in::date);
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS time_entries_pay_period_trigger ON time_entries;
CREATE TRIGGER time_entries_pay_period_trigger
  BEFORE INSERT OR UPDATE OF clock_in ON time_entries
  FOR EACH ROW
  EXECUTE FUNCTION time_entries_set_pay_period();

-- Backfill: assign pay_period_id to any existing entries (Phase 1 smoke-test
-- entries pre-date this migration). Future entries get assigned via trigger.
UPDATE time_entries
   SET pay_period_id = pay_period_for_date(clock_in::date)
 WHERE pay_period_id IS NULL;
