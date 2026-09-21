-- 072_pay_period_autocreate.sql
-- Fix: time entries punched after the last seeded pay period ran out were
-- inserted with pay_period_id = NULL, because pay_period_for_date() returned
-- NULL and the trigger from 017 just stored that. Those entries are invisible
-- to /quickbooks/sync-payroll/:id (it selects WHERE pay_period_id = $1), so
-- the sync reported success while pushing almost nothing to QBO Payroll.
--
-- Sep 3-16 2026 hit this: period 31 wasn't created until Sep 16 15:35, so 37
-- approved entries were orphaned. July 9-22 hit it earlier (36 entries).
--
-- Instead of relying on someone remembering to call /admin/extend, the
-- trigger now CREATES the covering period on demand from the same 14-day
-- Thursday grid used by 017 (anchor Thu Apr 30 2026).

-- Returns the period containing d, creating it if the calendar hasn't been
-- extended that far yet. Same grid as 017: 14 days from the anchor, pay date
-- is end + 5 days.
CREATE OR REPLACE FUNCTION pay_period_ensure_for_date(d DATE)
RETURNS INTEGER AS $$
DECLARE
  anchor DATE := '2026-04-30';   -- Thu, matches 017's seed anchor
  pid INTEGER;
  s DATE; e DATE; p DATE;
BEGIN
  SELECT id INTO pid
    FROM pay_periods
   WHERE d >= start_date AND d <= end_date
   LIMIT 1;
  IF pid IS NOT NULL THEN
    RETURN pid;
  END IF;

  -- Round d down onto the anchor grid (FLOOR also handles pre-anchor dates).
  s := anchor + (FLOOR((d - anchor)::numeric / 14) * 14)::int;
  e := s + 13;
  p := e + 5;

  INSERT INTO pay_periods (start_date, end_date, pay_date, status)
  VALUES (s, e, p, 'open')
  ON CONFLICT (start_date) DO NOTHING
  RETURNING id INTO pid;

  -- Lost the race with a concurrent punch - read back the winner's id.
  IF pid IS NULL THEN
    SELECT id INTO pid FROM pay_periods WHERE start_date = s;
  END IF;

  RETURN pid;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION time_entries_set_pay_period()
RETURNS TRIGGER AS $$
BEGIN
  NEW.pay_period_id := pay_period_ensure_for_date(NEW.clock_in::date);
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Adopt the entries that were orphaned while the calendar was short.
UPDATE time_entries
   SET pay_period_id = pay_period_ensure_for_date(clock_in::date)
 WHERE pay_period_id IS NULL;
