-- 019_employee_match_candidates.sql
-- QBO employee matching workflow: stores candidates suggested by the matcher,
-- tracks user review/confirmation, and audit history.
--
-- Workflow:
-- 1. Admin runs POST /api/quickbooks/match-employees
-- 2. Matcher analyzes local employees vs QBO employees
-- 3. For each local employee, top-N candidates are inserted here
-- 4. Admin reviews via UI, confirms their pick
-- 5. Confirmation updates employees.qbo_employee_id + marks this record confirmed
--
-- One row per candidate suggestion. Multiple rows per local_employee_id when
-- there are multiple candidates. Only one can be confirmed per employee.

CREATE TABLE IF NOT EXISTS employee_match_candidates (
  id              SERIAL PRIMARY KEY,
  local_employee_id INTEGER NOT NULL REFERENCES employees(id),
  qbo_employee_id TEXT NOT NULL,
  match_confidence NUMERIC(3,2) NOT NULL,
                  CHECK (match_confidence >= 0.00 AND match_confidence <= 1.00),
  match_reason    TEXT,                  -- e.g. "exact_full_name, email_domain_match"
  user_reviewed   BOOLEAN NOT NULL DEFAULT FALSE,
  user_confirmed  BOOLEAN NOT NULL DEFAULT FALSE,
  confirmed_by    INTEGER REFERENCES employees(id),
  confirmed_at    TIMESTAMPTZ,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  -- Only one confirmation per local employee
  CONSTRAINT one_confirmed_per_employee UNIQUE (local_employee_id)
    WHERE user_confirmed = TRUE
);

-- Index for quick lookup of candidates for a local employee (for review UI)
CREATE INDEX IF NOT EXISTS idx_match_candidates_local_employee
  ON employee_match_candidates (local_employee_id, match_confidence DESC);

-- Index for finding all unreviewed candidates (the /pending-matches endpoint)
CREATE INDEX IF NOT EXISTS idx_match_candidates_pending
  ON employee_match_candidates (user_reviewed, user_confirmed)
  WHERE user_reviewed = FALSE;

-- Auto-bump updated_at
CREATE OR REPLACE FUNCTION employee_match_candidates_set_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at := NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS employee_match_candidates_updated_at_trigger ON employee_match_candidates;
CREATE TRIGGER employee_match_candidates_updated_at_trigger
  BEFORE UPDATE ON employee_match_candidates
  FOR EACH ROW
  EXECUTE FUNCTION employee_match_candidates_set_updated_at();
