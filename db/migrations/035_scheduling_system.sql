-- 035_scheduling_system.sql
-- Job-progress scheduling system. Covers all four phases:
--
--   Phase 1 — install calendar:        project_install_schedule
--   Phase 2 — per-job task list:       job_tasks
--   Phase 3 — sign-type templates:     task_templates + task_template_steps
--   Phase 4 — resource leveling:       resources (referenced by both Phase 1
--                                                  and Phase 2/3 rows)
--
-- All rollouts share the same `resources` lookup so a "Crew 1" or "CNC
-- machine" can be assigned to an install date AND to a per-job task in
-- one row's lifetime, and the Phase 4 conflict view can sum hours across
-- both. project_id FKs cascade so a deleted project takes its schedule
-- with it; resource FKs don't, because a resource's history is
-- meaningful even after the resource is retired.
--
-- Indexes are picked for the two hot paths:
--   • Calendar (Phase 1) — WHERE install_date BETWEEN $a AND $b
--   • Gantt (Phase 2)     — WHERE planned_start <= $end AND planned_end >= $start
--   • Resource view (P4)  — WHERE resource_id = $r AND date-range

BEGIN;

-- ─── Resources ────────────────────────────────────────────────────────────
-- A resource is anything with finite daily capacity: a crew (Travis +
-- one), a machine (CNC, paint booth, wide-format), a vehicle (install
-- truck), or a facility (install bay, sandblast booth). Type only
-- changes the icon/filter — the capacity math is the same for all.
CREATE TABLE IF NOT EXISTS resources (
  id                   SERIAL PRIMARY KEY,
  name                 TEXT NOT NULL,
  resource_type        TEXT NOT NULL
    CHECK (resource_type IN ('crew', 'machine', 'vehicle', 'facility', 'person')),
  -- Default 8h matches one full work-day. Crane day / paint booth can
  -- override (crane = 1 install/day → set to NULL to mean "1 unit", or
  -- keep 8h and treat the install task as filling the whole day).
  daily_capacity_hours NUMERIC(4,1) NOT NULL DEFAULT 8.0,
  -- Hex color for the calendar swimlane / task bar. NULL → auto-assign
  -- on first render.
  color                TEXT,
  active               BOOLEAN NOT NULL DEFAULT TRUE,
  notes                TEXT,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_resources_active ON resources(active) WHERE active;

-- ─── Phase 1: install schedule ────────────────────────────────────────────
-- One row per scheduled install for a project. Most jobs only ever have
-- one row; multi-day installs (banner-wrap + lettering done a week
-- apart, for example) get multiple rows under the same project_id.
CREATE TABLE IF NOT EXISTS project_install_schedule (
  id                 SERIAL PRIMARY KEY,
  project_id         INT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  install_date       DATE NOT NULL,
  -- start_time + duration is preferred over end_time so a "morning
  -- install" without a hard finish doesn't need to lie about an end.
  start_time         TIME,
  duration_hours     NUMERIC(4,1),
  crew_resource_id   INT REFERENCES resources(id),
  notes              TEXT,
  -- Soft-flag for weather. Doesn't auto-reschedule; it just paints the
  -- calendar bar yellow + bubbles to the assignee.
  weather_blocked    BOOLEAN NOT NULL DEFAULT FALSE,
  status             TEXT NOT NULL DEFAULT 'scheduled'
    CHECK (status IN ('scheduled', 'in_progress', 'completed', 'postponed', 'cancelled')),
  scheduled_by       INT REFERENCES employees(id),
  created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_install_sched_date    ON project_install_schedule(install_date);
CREATE INDEX IF NOT EXISTS idx_install_sched_project ON project_install_schedule(project_id);
CREATE INDEX IF NOT EXISTS idx_install_sched_crew    ON project_install_schedule(crew_resource_id, install_date);

-- ─── Phase 3: task templates ──────────────────────────────────────────────
-- A template is an ordered list of steps for a sign type. Applying a
-- template to a project copies its steps into job_tasks with planned
-- dates computed from the project's due_date (or install date) working
-- backwards. Templates are versioned implicitly — we never edit a step
-- in place once a project has applied it (we clone the template if
-- shop process changes).
CREATE TABLE IF NOT EXISTS task_templates (
  id              SERIAL PRIMARY KEY,
  name            TEXT NOT NULL,
  -- Optional — when set, the template auto-suggests for jobs of this
  -- project_type. NULL means "manual apply only" (e.g. a general /
  -- catch-all template).
  project_type_id INT,
  active          BOOLEAN NOT NULL DEFAULT TRUE,
  notes           TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS task_template_steps (
  id                    SERIAL PRIMARY KEY,
  template_id           INT NOT NULL REFERENCES task_templates(id) ON DELETE CASCADE,
  -- step_order is the canonical sort key. Gaps allowed so inserts don't
  -- renumber. depends_on_order references the prerequisite step within
  -- the same template; NULL = no predecessor (parallel-eligible).
  step_order            INT NOT NULL,
  name                  TEXT NOT NULL,
  default_duration_days NUMERIC(4,1) NOT NULL DEFAULT 1.0,
  default_resource_id   INT REFERENCES resources(id),
  depends_on_order      INT,
  -- task_kind drives visual + scheduling behaviour:
  --   labor          — billable work, counts toward resource capacity
  --   customer_wait  — proof approval etc, zero capacity, blocks downstream
  --   vendor_wait    — module order, permit pull (no labor, just lead time)
  --   milestone      — zero duration, just a marker on the timeline
  task_kind             TEXT NOT NULL DEFAULT 'labor'
    CHECK (task_kind IN ('labor', 'customer_wait', 'vendor_wait', 'permit', 'milestone')),
  notes                 TEXT,
  UNIQUE (template_id, step_order)
);
CREATE INDEX IF NOT EXISTS idx_task_template_steps_template ON task_template_steps(template_id, step_order);

-- ─── Phase 2: per-job tasks ───────────────────────────────────────────────
-- A row per actual step on an actual job. Either created from a template
-- (template_id set, step_order matches the template's step_order) or
-- ad-hoc (template_id NULL). Planned dates can shift; actual dates
-- record reality. Resource and assignee are independent: a paint job
-- happens on the "Paint Booth" resource AND is done by an employee.
CREATE TABLE IF NOT EXISTS job_tasks (
  id                 SERIAL PRIMARY KEY,
  project_id         INT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  template_id        INT REFERENCES task_templates(id),
  step_order         INT NOT NULL,
  name               TEXT NOT NULL,
  task_kind          TEXT NOT NULL DEFAULT 'labor'
    CHECK (task_kind IN ('labor', 'customer_wait', 'vendor_wait', 'permit', 'milestone')),
  planned_start      DATE,
  planned_end        DATE,
  actual_start       DATE,
  actual_end         DATE,
  duration_hours     NUMERIC(4,1),
  assigned_emp_id    INT REFERENCES employees(id),
  resource_id        INT REFERENCES resources(id),
  -- Within-project DAG. Points at job_tasks.id so we don't have to do a
  -- (project_id, step_order) compound lookup at runtime.
  depends_on_task_id INT REFERENCES job_tasks(id) ON DELETE SET NULL,
  status             TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'in_progress', 'completed', 'blocked', 'skipped')),
  notes              TEXT,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_job_tasks_project  ON job_tasks(project_id, step_order);
CREATE INDEX IF NOT EXISTS idx_job_tasks_planned  ON job_tasks(planned_start, planned_end);
CREATE INDEX IF NOT EXISTS idx_job_tasks_resource ON job_tasks(resource_id, planned_start)
  WHERE resource_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_job_tasks_assignee ON job_tasks(assigned_emp_id, planned_start)
  WHERE assigned_emp_id IS NOT NULL;

-- Touch-trigger on updated_at for install schedule + job_tasks. Lets
-- the UI show "last edited 5 min ago" without us having to remember
-- to bump it in every PATCH handler.
CREATE OR REPLACE FUNCTION touch_updated_at() RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END $$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_install_sched_touch ON project_install_schedule;
CREATE TRIGGER trg_install_sched_touch BEFORE UPDATE ON project_install_schedule
  FOR EACH ROW EXECUTE FUNCTION touch_updated_at();

DROP TRIGGER IF EXISTS trg_job_tasks_touch ON job_tasks;
CREATE TRIGGER trg_job_tasks_touch BEFORE UPDATE ON job_tasks
  FOR EACH ROW EXECUTE FUNCTION touch_updated_at();

-- ─── Seed resources ───────────────────────────────────────────────────────
-- Reasonable defaults for a Walkerton sign shop. Staff can edit names /
-- add/retire via the admin UI in Phase 3; this just gives the calendar
-- something to render on day one.
INSERT INTO resources (name, resource_type, daily_capacity_hours, color, notes) VALUES
  ('Install Crew 1',     'crew',     8.0, '#0ea5e9', 'Primary install crew'),
  ('Install Crew 2',     'crew',     8.0, '#22c55e', 'Secondary install crew'),
  ('Crane Day',          'vehicle',  8.0, '#f59e0b', 'Full-day rental, one job per day'),
  ('CNC Machine',        'machine',  8.0, '#8b5cf6', 'Sign shop CNC'),
  ('Wide-Format Printer','machine',  8.0, '#ec4899', 'Solvent / UV printer'),
  ('DTF Printer',        'machine',  8.0, '#06b6d4', 'DTF transfer printer'),
  ('Plotter',            'machine',  8.0, '#6366f1', 'Vinyl plotter'),
  ('Paint Booth',        'facility', 8.0, '#ef4444', 'Spray booth; allow 16hr cure block between coats'),
  ('Install Bay',        'facility', 8.0, '#10b981', 'Indoor wrap / install bay')
ON CONFLICT DO NOTHING;

-- ─── Seed templates ──────────────────────────────────────────────────────
-- Templates are inserted only if their name doesn't already exist, so
-- re-running the migration on a shop that's already customised theirs
-- is safe. project_type_id is left NULL — staff can wire up the type
-- mapping via the admin UI once they see what types they actually use.

INSERT INTO task_templates (name, notes) VALUES
  ('Vinyl Decal',     'Cut vinyl, transfer-tape, on-site install'),
  ('Banner',          'Print, trim, grommet'),
  ('Vehicle Wrap',    'Measure → design → print → install bay (1 day)'),
  ('Channel Letter Sign', 'Design → permit → CNC → paint → LED wire → crane install'),
  ('LED Display',     'Design → module order (vendor lead) → cabinet build → crane install'),
  ('Monument / Pylon','Design → engineer stamp → fabricate → paint → crane install'),
  ('Window Graphics', 'Design → print → on-site install'),
  ('Magnetic Signs',  'Design → print → deliver')
ON CONFLICT DO NOTHING;

-- Helper to insert template steps without having to look up the
-- template id by name every line. Uses a CTE so the seed is one
-- statement per template.

-- Vinyl Decal
WITH t AS (SELECT id FROM task_templates WHERE name = 'Vinyl Decal' LIMIT 1)
INSERT INTO task_template_steps (template_id, step_order, name, default_duration_days, default_resource_id, depends_on_order, task_kind)
SELECT t.id, s.* FROM t,
  (VALUES
    (10, 'Design',          1.0::numeric, (SELECT id FROM resources WHERE name='Plotter' LIMIT 1),  NULL, 'labor'),
    (20, 'Customer proof',  1.0::numeric, NULL::int, 10,   'customer_wait'),
    (30, 'Plot + weed',     0.5::numeric, (SELECT id FROM resources WHERE name='Plotter' LIMIT 1),  20, 'labor'),
    (40, 'Install',         1.0::numeric, (SELECT id FROM resources WHERE name='Install Crew 1' LIMIT 1), 30, 'labor')
  ) s(step_order, name, default_duration_days, default_resource_id, depends_on_order, task_kind)
ON CONFLICT DO NOTHING;

-- Banner
WITH t AS (SELECT id FROM task_templates WHERE name = 'Banner' LIMIT 1)
INSERT INTO task_template_steps (template_id, step_order, name, default_duration_days, default_resource_id, depends_on_order, task_kind)
SELECT t.id, s.* FROM t,
  (VALUES
    (10, 'Design',           1.0::numeric, NULL::int, NULL, 'labor'),
    (20, 'Customer proof',   1.0::numeric, NULL::int, 10,   'customer_wait'),
    (30, 'Print',            0.5::numeric, (SELECT id FROM resources WHERE name='Wide-Format Printer' LIMIT 1), 20, 'labor'),
    (40, 'Trim + grommet',   0.5::numeric, NULL::int, 30,   'labor')
  ) s(step_order, name, default_duration_days, default_resource_id, depends_on_order, task_kind)
ON CONFLICT DO NOTHING;

-- Vehicle Wrap
WITH t AS (SELECT id FROM task_templates WHERE name = 'Vehicle Wrap' LIMIT 1)
INSERT INTO task_template_steps (template_id, step_order, name, default_duration_days, default_resource_id, depends_on_order, task_kind)
SELECT t.id, s.* FROM t,
  (VALUES
    (10, 'Measure vehicle',  0.5::numeric, NULL::int, NULL, 'labor'),
    (20, 'Design',           2.0::numeric, NULL::int, 10,   'labor'),
    (30, 'Customer proof',   2.0::numeric, NULL::int, 20,   'customer_wait'),
    (40, 'Print wrap',       0.5::numeric, (SELECT id FROM resources WHERE name='Wide-Format Printer' LIMIT 1), 30, 'labor'),
    (50, 'Install (bay)',    1.0::numeric, (SELECT id FROM resources WHERE name='Install Bay' LIMIT 1), 40, 'labor')
  ) s(step_order, name, default_duration_days, default_resource_id, depends_on_order, task_kind)
ON CONFLICT DO NOTHING;

-- Channel Letter Sign
WITH t AS (SELECT id FROM task_templates WHERE name = 'Channel Letter Sign' LIMIT 1)
INSERT INTO task_template_steps (template_id, step_order, name, default_duration_days, default_resource_id, depends_on_order, task_kind)
SELECT t.id, s.* FROM t,
  (VALUES
    (10, 'Design',                 3.0::numeric, NULL::int, NULL, 'labor'),
    (20, 'Customer proof',         3.0::numeric, NULL::int, 10,   'customer_wait'),
    (30, 'Permit application',    10.0::numeric, NULL::int, 20,   'permit'),
    (40, 'CNC cut faces + returns',1.0::numeric, (SELECT id FROM resources WHERE name='CNC Machine' LIMIT 1), 20, 'labor'),
    (50, 'Paint',                  2.0::numeric, (SELECT id FROM resources WHERE name='Paint Booth' LIMIT 1), 40, 'labor'),
    (60, 'LED wiring + assembly',  1.0::numeric, NULL::int, 50,   'labor'),
    (70, 'Install (crane)',        1.0::numeric, (SELECT id FROM resources WHERE name='Crane Day' LIMIT 1), 60, 'labor')
  ) s(step_order, name, default_duration_days, default_resource_id, depends_on_order, task_kind)
ON CONFLICT DO NOTHING;

-- LED Display
WITH t AS (SELECT id FROM task_templates WHERE name = 'LED Display' LIMIT 1)
INSERT INTO task_template_steps (template_id, step_order, name, default_duration_days, default_resource_id, depends_on_order, task_kind)
SELECT t.id, s.* FROM t,
  (VALUES
    (10, 'Design + module spec',   2.0::numeric, NULL::int, NULL, 'labor'),
    (20, 'Customer proof',         2.0::numeric, NULL::int, 10,   'customer_wait'),
    (30, 'Order modules (vendor)',21.0::numeric, NULL::int, 20,   'vendor_wait'),
    (40, 'Build cabinet',          3.0::numeric, (SELECT id FROM resources WHERE name='CNC Machine' LIMIT 1), 30, 'labor'),
    (50, 'Wire + program',         1.0::numeric, NULL::int, 40,   'labor'),
    (60, 'Install (crane)',        1.0::numeric, (SELECT id FROM resources WHERE name='Crane Day' LIMIT 1), 50, 'labor')
  ) s(step_order, name, default_duration_days, default_resource_id, depends_on_order, task_kind)
ON CONFLICT DO NOTHING;

-- Monument / Pylon
WITH t AS (SELECT id FROM task_templates WHERE name = 'Monument / Pylon' LIMIT 1)
INSERT INTO task_template_steps (template_id, step_order, name, default_duration_days, default_resource_id, depends_on_order, task_kind)
SELECT t.id, s.* FROM t,
  (VALUES
    (10, 'Design',                 3.0::numeric, NULL::int, NULL, 'labor'),
    (20, 'Engineer stamp',         5.0::numeric, NULL::int, 10,   'vendor_wait'),
    (30, 'Fabricate',              5.0::numeric, (SELECT id FROM resources WHERE name='CNC Machine' LIMIT 1), 20, 'labor'),
    (40, 'Paint',                  2.0::numeric, (SELECT id FROM resources WHERE name='Paint Booth' LIMIT 1), 30, 'labor'),
    (50, 'Install (crane)',        1.0::numeric, (SELECT id FROM resources WHERE name='Crane Day' LIMIT 1), 40, 'labor')
  ) s(step_order, name, default_duration_days, default_resource_id, depends_on_order, task_kind)
ON CONFLICT DO NOTHING;

-- Window Graphics
WITH t AS (SELECT id FROM task_templates WHERE name = 'Window Graphics' LIMIT 1)
INSERT INTO task_template_steps (template_id, step_order, name, default_duration_days, default_resource_id, depends_on_order, task_kind)
SELECT t.id, s.* FROM t,
  (VALUES
    (10, 'Design',           1.0::numeric, NULL::int, NULL, 'labor'),
    (20, 'Customer proof',   1.0::numeric, NULL::int, 10,   'customer_wait'),
    (30, 'Print',            0.5::numeric, (SELECT id FROM resources WHERE name='Wide-Format Printer' LIMIT 1), 20, 'labor'),
    (40, 'Install',          1.0::numeric, (SELECT id FROM resources WHERE name='Install Crew 1' LIMIT 1), 30, 'labor')
  ) s(step_order, name, default_duration_days, default_resource_id, depends_on_order, task_kind)
ON CONFLICT DO NOTHING;

-- Magnetic Signs
WITH t AS (SELECT id FROM task_templates WHERE name = 'Magnetic Signs' LIMIT 1)
INSERT INTO task_template_steps (template_id, step_order, name, default_duration_days, default_resource_id, depends_on_order, task_kind)
SELECT t.id, s.* FROM t,
  (VALUES
    (10, 'Design',         1.0::numeric, NULL::int, NULL, 'labor'),
    (20, 'Customer proof', 1.0::numeric, NULL::int, 10,   'customer_wait'),
    (30, 'Print',          0.5::numeric, (SELECT id FROM resources WHERE name='Wide-Format Printer' LIMIT 1), 20, 'labor'),
    (40, 'Deliver',        0.5::numeric, NULL::int, 30,   'labor')
  ) s(step_order, name, default_duration_days, default_resource_id, depends_on_order, task_kind)
ON CONFLICT DO NOTHING;

COMMIT;
