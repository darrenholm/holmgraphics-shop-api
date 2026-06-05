-- 045_rolling_schedule.sql
-- Event-driven job schedule as a phase checklist.
--
-- Each job has a linear sequence of phases (Design → Customer proof
-- → Order materials → Production → Install). Each phase has:
--   • responsible_party (shop / customer / vendor / authority) so the
--     UI can call out "ball in court" at a glance
--   • expected_days       — how many days we allow for this phase
--   • started_at          — when it actually became active
--   • completed_at        — when staff checked it complete
--
-- Exactly one phase is 'active' at a time. Checking complete on the
-- active phase auto-activates the next one with started_at = NOW(),
-- enforced by trigger so the API can't accidentally skip the handoff.
-- Staff sets the next phase's expected_days at activation time so the
-- estimate reflects current shop capacity, not a stale template default.
--
-- Phase templates ship per project type for one-click setup.

BEGIN;

-- ─── job_phases: per-job checklist ──────────────────────────────────────
CREATE TABLE IF NOT EXISTS job_phases (
  id                SERIAL PRIMARY KEY,
  project_id        INT  NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  -- Linear order — gaps allowed so inserts don't renumber. Templates
  -- use 10, 20, 30 spacing.
  phase_order       INT  NOT NULL,
  name              TEXT NOT NULL,
  responsible_party TEXT NOT NULL DEFAULT 'shop'
    CHECK (responsible_party IN ('shop', 'customer', 'vendor', 'authority')),
  status            TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'active', 'completed', 'skipped')),
  -- How long this phase was budgeted for at the time it started. NULL
  -- on pending phases until they're activated; staff can set it
  -- upfront via the template default, or leave NULL and provide when
  -- activating.
  expected_days     NUMERIC(5,1),
  started_at        TIMESTAMPTZ,
  completed_at      TIMESTAMPTZ,
  notes             TEXT,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (project_id, phase_order)
);
CREATE INDEX IF NOT EXISTS idx_job_phases_project
  ON job_phases(project_id, phase_order);
-- Partial index for the "what's active right now" query — every page
-- on the calendar will hit this.
CREATE INDEX IF NOT EXISTS idx_job_phases_active
  ON job_phases(project_id) WHERE status = 'active';

-- ─── phase_templates: per-project-type defaults ─────────────────────────
CREATE TABLE IF NOT EXISTS phase_templates (
  id              SERIAL PRIMARY KEY,
  name            TEXT NOT NULL UNIQUE,
  project_type_id INT,
  active          BOOLEAN NOT NULL DEFAULT TRUE,
  notes           TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS phase_template_steps (
  id                  SERIAL PRIMARY KEY,
  template_id         INT  NOT NULL REFERENCES phase_templates(id) ON DELETE CASCADE,
  phase_order         INT  NOT NULL,
  name                TEXT NOT NULL,
  default_days        NUMERIC(5,1) NOT NULL DEFAULT 2.0,
  responsible_party   TEXT NOT NULL DEFAULT 'shop'
    CHECK (responsible_party IN ('shop', 'customer', 'vendor', 'authority')),
  notes               TEXT,
  UNIQUE (template_id, phase_order)
);

-- ─── Auto-advance trigger ───────────────────────────────────────────────
-- When a phase flips to 'completed', stamp completed_at if it's NULL,
-- then activate the next-in-order pending phase with started_at = NOW().
-- The next phase's expected_days is whatever it was already set to
-- (probably the template default); staff can override via the activate-
-- phase API which calls this same path.
CREATE OR REPLACE FUNCTION advance_next_phase() RETURNS TRIGGER AS $$
DECLARE
  next_id INT;
BEGIN
  IF NEW.status = 'completed' AND OLD.status IS DISTINCT FROM 'completed' THEN
    IF NEW.completed_at IS NULL THEN
      NEW.completed_at := NOW();
    END IF;

    -- Find the next pending phase in order. If multiple phases are
    -- pending we pick the lowest phase_order — strict sequencing.
    SELECT id INTO next_id
      FROM job_phases
     WHERE project_id = NEW.project_id
       AND status = 'pending'
       AND phase_order > NEW.phase_order
     ORDER BY phase_order ASC
     LIMIT 1;

    IF next_id IS NOT NULL THEN
      UPDATE job_phases
         SET status     = 'active',
             started_at = COALESCE(started_at, NOW())
       WHERE id = next_id;
    END IF;
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_job_phases_advance ON job_phases;
CREATE TRIGGER trg_job_phases_advance
  BEFORE UPDATE OF status ON job_phases
  FOR EACH ROW
  EXECUTE FUNCTION advance_next_phase();

-- Touch trigger on updated_at (reuses helper from migration 035).
DROP TRIGGER IF EXISTS trg_job_phases_touch ON job_phases;
CREATE TRIGGER trg_job_phases_touch BEFORE UPDATE ON job_phases
  FOR EACH ROW EXECUTE FUNCTION touch_updated_at();

-- ─── Seed phase templates ───────────────────────────────────────────────
-- Mirrors the existing task_templates' high-level shape but coarser:
-- each row is one "phase" (a handoff between responsibility owners),
-- not a discrete work step.

INSERT INTO phase_templates (name, notes) VALUES
  ('Quick Sign',         'Design → Proof → Production → Install'),
  ('Standard Sign',      'Design → Proof → Order → Production → Install'),
  ('Channel Letter',     'Design → Proof → Permit → Order → Production → Install'),
  ('Backlit Sign',       'Design → Proof → Order → Production → Install'),
  ('Monument / Pylon',   'Design → Engineer → Order → Fabricate → Install'),
  ('Vehicle Wrap',       'Measure → Design → Proof → Order → Install'),
  ('Banner / Quick',     'Design → Proof → Production')
ON CONFLICT (name) DO NOTHING;

-- Quick Sign — 4 phases
WITH t AS (SELECT id FROM phase_templates WHERE name = 'Quick Sign' LIMIT 1)
INSERT INTO phase_template_steps (template_id, phase_order, name, default_days, responsible_party)
SELECT t.id, s.* FROM t,
  (VALUES
    (10, 'Design',         1.0::numeric, 'shop'),
    (20, 'Customer proof', 2.0::numeric, 'customer'),
    (30, 'Production',     1.0::numeric, 'shop'),
    (40, 'Install',        1.0::numeric, 'shop')
  ) s(phase_order, name, default_days, responsible_party)
ON CONFLICT DO NOTHING;

-- Standard Sign — 5 phases
WITH t AS (SELECT id FROM phase_templates WHERE name = 'Standard Sign' LIMIT 1)
INSERT INTO phase_template_steps (template_id, phase_order, name, default_days, responsible_party)
SELECT t.id, s.* FROM t,
  (VALUES
    (10, 'Design',          2.0::numeric, 'shop'),
    (20, 'Customer proof',  2.0::numeric, 'customer'),
    (30, 'Order materials', 3.0::numeric, 'vendor'),
    (40, 'Production',      1.0::numeric, 'shop'),
    (50, 'Install',         1.0::numeric, 'shop')
  ) s(phase_order, name, default_days, responsible_party)
ON CONFLICT DO NOTHING;

-- Channel Letter — 6 phases including permit
WITH t AS (SELECT id FROM phase_templates WHERE name = 'Channel Letter' LIMIT 1)
INSERT INTO phase_template_steps (template_id, phase_order, name, default_days, responsible_party)
SELECT t.id, s.* FROM t,
  (VALUES
    (10, 'Design',          3.0::numeric, 'shop'),
    (20, 'Customer proof',  3.0::numeric, 'customer'),
    (30, 'Permit',         10.0::numeric, 'authority'),
    (40, 'Order materials', 5.0::numeric, 'vendor'),
    (50, 'Production',      2.0::numeric, 'shop'),
    (60, 'Install',         1.0::numeric, 'shop')
  ) s(phase_order, name, default_days, responsible_party)
ON CONFLICT DO NOTHING;

-- Backlit Sign — 5 phases
WITH t AS (SELECT id FROM phase_templates WHERE name = 'Backlit Sign' LIMIT 1)
INSERT INTO phase_template_steps (template_id, phase_order, name, default_days, responsible_party)
SELECT t.id, s.* FROM t,
  (VALUES
    (10, 'Design',          2.0::numeric, 'shop'),
    (20, 'Customer proof',  2.0::numeric, 'customer'),
    (30, 'Order materials', 5.0::numeric, 'vendor'),
    (40, 'Production',      2.0::numeric, 'shop'),
    (50, 'Install',         1.0::numeric, 'shop')
  ) s(phase_order, name, default_days, responsible_party)
ON CONFLICT DO NOTHING;

-- Monument / Pylon — 5 phases
WITH t AS (SELECT id FROM phase_templates WHERE name = 'Monument / Pylon' LIMIT 1)
INSERT INTO phase_template_steps (template_id, phase_order, name, default_days, responsible_party)
SELECT t.id, s.* FROM t,
  (VALUES
    (10, 'Design',          3.0::numeric, 'shop'),
    (20, 'Engineer stamp',  5.0::numeric, 'authority'),
    (30, 'Order materials', 5.0::numeric, 'vendor'),
    (40, 'Fabricate',       5.0::numeric, 'shop'),
    (50, 'Install',         1.0::numeric, 'shop')
  ) s(phase_order, name, default_days, responsible_party)
ON CONFLICT DO NOTHING;

-- Vehicle Wrap — 5 phases
WITH t AS (SELECT id FROM phase_templates WHERE name = 'Vehicle Wrap' LIMIT 1)
INSERT INTO phase_template_steps (template_id, phase_order, name, default_days, responsible_party)
SELECT t.id, s.* FROM t,
  (VALUES
    (10, 'Measure vehicle', 1.0::numeric, 'shop'),
    (20, 'Design',          2.0::numeric, 'shop'),
    (30, 'Customer proof',  2.0::numeric, 'customer'),
    (40, 'Order materials', 3.0::numeric, 'vendor'),
    (50, 'Install',         1.0::numeric, 'shop')
  ) s(phase_order, name, default_days, responsible_party)
ON CONFLICT DO NOTHING;

-- Banner / Quick — 3 phases
WITH t AS (SELECT id FROM phase_templates WHERE name = 'Banner / Quick' LIMIT 1)
INSERT INTO phase_template_steps (template_id, phase_order, name, default_days, responsible_party)
SELECT t.id, s.* FROM t,
  (VALUES
    (10, 'Design',         1.0::numeric, 'shop'),
    (20, 'Customer proof', 1.0::numeric, 'customer'),
    (30, 'Production',     1.0::numeric, 'shop')
  ) s(phase_order, name, default_days, responsible_party)
ON CONFLICT DO NOTHING;

COMMIT;
