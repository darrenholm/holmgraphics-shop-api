-- 043_absences_and_holidays.sql
-- Two related tables for "when can staff actually work":
--
--   staff_absences — date ranges (or date + time blocks) where a
--                    person is off. Covers full-day vacation, half-day
--                    sick, hour-long doctor appointments, etc.
--   holidays       — shop-closed days, calendar-wide overlay.
--
-- The calendar UI cross-references these against task / install
-- swimlanes:
--   • Holidays paint the column with a diagonal stripe
--   • Absences paint the affected employee's row cells with a
--     coloured chip (full-day) or a time-labeled block (partial)
--   • Weekends are already styled in the existing calendar code
--
-- Seeds Ontario statutory holidays for 2026 + 2027 so the calendar
-- has something to render on day one. Future years staff add manually
-- via the admin UI, or we can ship another seed migration.

BEGIN;

-- ─── Staff absences ──────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS staff_absences (
  id           SERIAL PRIMARY KEY,
  employee_id  INT NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
  start_date   DATE NOT NULL,
  end_date     DATE NOT NULL,           -- inclusive; equal to start_date for single-day
  -- Partial-day windows. NULL = whole day(s). Constraint enforces that
  -- a time range only goes on a single-day absence (multi-day partial
  -- blocks don't make sense — split into one entry per day).
  start_time   TIME,
  end_time     TIME,
  kind         TEXT NOT NULL DEFAULT 'personal'
    CHECK (kind IN ('vacation', 'sick', 'personal', 'appointment', 'training', 'other')),
  notes        TEXT,
  created_by   INT REFERENCES employees(id),
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT end_after_start         CHECK (end_date >= start_date),
  CONSTRAINT time_only_on_single_day CHECK (start_date = end_date OR start_time IS NULL),
  CONSTRAINT time_pair_consistent    CHECK ((start_time IS NULL AND end_time IS NULL)
                                         OR (start_time IS NOT NULL AND end_time IS NOT NULL AND end_time > start_time))
);
CREATE INDEX IF NOT EXISTS idx_absences_employee_window
  ON staff_absences(employee_id, start_date, end_date);
CREATE INDEX IF NOT EXISTS idx_absences_window
  ON staff_absences(start_date, end_date);

DROP TRIGGER IF EXISTS trg_absences_touch ON staff_absences;
CREATE TRIGGER trg_absences_touch BEFORE UPDATE ON staff_absences
  FOR EACH ROW EXECUTE FUNCTION touch_updated_at();   -- defined in migration 035

-- ─── Holidays ────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS holidays (
  id          SERIAL PRIMARY KEY,
  date        DATE NOT NULL UNIQUE,
  name        TEXT NOT NULL,
  -- Some "holidays" the shop chooses not to observe (e.g. Family Day
  -- in some businesses). Setting observed=false keeps the row for
  -- reference but skips the calendar overlay.
  observed    BOOLEAN NOT NULL DEFAULT TRUE,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_holidays_date ON holidays(date) WHERE observed;

-- Seed Ontario statutory holidays — 2026 and 2027. Dates from the
-- Ontario Ministry of Labour calendar. ON CONFLICT lets the migration
-- re-run safely.
INSERT INTO holidays (date, name) VALUES
  -- 2026
  ('2026-01-01', 'New Year''s Day'),
  ('2026-02-16', 'Family Day'),
  ('2026-04-03', 'Good Friday'),
  ('2026-05-18', 'Victoria Day'),
  ('2026-07-01', 'Canada Day'),
  ('2026-08-03', 'Civic Holiday'),
  ('2026-09-07', 'Labour Day'),
  ('2026-10-12', 'Thanksgiving'),
  ('2026-12-25', 'Christmas Day'),
  ('2026-12-28', 'Boxing Day (observed)'),
  -- 2027
  ('2027-01-01', 'New Year''s Day'),
  ('2027-02-15', 'Family Day'),
  ('2027-03-26', 'Good Friday'),
  ('2027-05-24', 'Victoria Day'),
  ('2027-07-01', 'Canada Day'),
  ('2027-08-02', 'Civic Holiday'),
  ('2027-09-06', 'Labour Day'),
  ('2027-10-11', 'Thanksgiving'),
  ('2027-12-27', 'Christmas Day (observed)'),
  ('2027-12-28', 'Boxing Day (observed)')
ON CONFLICT (date) DO NOTHING;

COMMIT;
