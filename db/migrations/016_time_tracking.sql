-- 016_time_tracking.sql
-- Time-clock entries for the staff time-tracking module.
--
-- One row per clock-in/out shift segment. An "open" entry has clock_out NULL;
-- closing it transitions status to 'closed'. Manager review (optional)
-- promotes it to 'approved'. The CSV/QBO export marks entries 'exported' so
-- they aren't double-counted on the next pay period run.
--
-- project_id is optional and supports per-job time attribution. Phase 1 leaves
-- it NULL for everything. Phase 1.5 wires the "Switch Job" UI; the schema is
-- already ready for it so no further migration is needed.
--
-- Status flow: open → closed → approved → exported. Manual edits via the
-- admin endpoints can move between adjacent states if needed (e.g., un-approve).

CREATE TABLE IF NOT EXISTS time_entries (
  id              SERIAL PRIMARY KEY,
  employee_id     INTEGER NOT NULL REFERENCES employees(id),
  clock_in        TIMESTAMPTZ NOT NULL,
  clock_out       TIMESTAMPTZ,
  project_id      INTEGER REFERENCES projects(id),
  notes           TEXT,
  status          TEXT NOT NULL DEFAULT 'open'
                  CHECK (status IN ('open', 'closed', 'approved', 'exported')),
  approved_by     INTEGER REFERENCES employees(id),
  approved_at     TIMESTAMPTZ,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT clock_out_after_in CHECK (clock_out IS NULL OR clock_out > clock_in),
  CONSTRAINT open_means_no_clock_out CHECK (
    (status = 'open' AND clock_out IS NULL) OR
    (status <> 'open' AND clock_out IS NOT NULL)
  )
);

-- Hot path: "list my entries between these dates" — covered by employee + clock_in DESC.
CREATE INDEX IF NOT EXISTS idx_time_entries_employee_in
  ON time_entries (employee_id, clock_in DESC);

-- DB-level guarantee: at most one open entry per employee. The unique partial
-- index throws on a second concurrent clock-in attempt, which the route
-- handler catches and returns as a 409 to the client.
CREATE UNIQUE INDEX IF NOT EXISTS idx_time_entries_one_open_per_employee
  ON time_entries (employee_id) WHERE status = 'open';

-- For the per-job rollups on the project detail page (Phase 1.5).
CREATE INDEX IF NOT EXISTS idx_time_entries_project
  ON time_entries (project_id) WHERE project_id IS NOT NULL;

-- Auto-bump updated_at on any UPDATE. Mirrors the pattern used by clients
-- (see migration 008) and other tables in this schema.
CREATE OR REPLACE FUNCTION time_entries_set_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at := NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS time_entries_updated_at_trigger ON time_entries;
CREATE TRIGGER time_entries_updated_at_trigger
  BEFORE UPDATE ON time_entries
  FOR EACH ROW
  EXECUTE FUNCTION time_entries_set_updated_at();
