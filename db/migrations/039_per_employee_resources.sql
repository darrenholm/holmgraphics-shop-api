-- 039_per_employee_resources.sql
-- Replace the single "Staff Assigned" bucket with one resource row per
-- active employee, so the install calendar can show each staff member
-- as their own swimlane and surface when they're booked.
--
-- Two structural pieces:
--   1. resources.employee_id  → explicit link to the employees row.
--      Lets us keep the resource in sync with the employee (rename,
--      retire) and avoids fragile name-matching for a shop with
--      common first names.
--   2. INSERT one resource per active employee with NO existing link,
--      so re-running after a manual admin-UI add is idempotent.
--
-- Existing data:
--   • Task templates that defaulted to "Staff Assigned" lose their
--     default_resource_id (NULL) — the new model is "assign to a
--     specific person via job_tasks.assigned_emp_id" rather than a
--     generic bucket. Templates still apply; the resource_id on the
--     resulting task just stays empty for staff to fill in.
--   • The "Staff Assigned" resource itself is soft-retired
--     (active=FALSE) so it disappears from dropdowns and calendar
--     swimlanes. Any in-flight install_schedule rows still referencing
--     it stay valid (no FK cascade); they'll render in an inactive
--     bucket the UI hides by default.

BEGIN;

-- ─── Schema: link resources ↔ employees ─────────────────────────────────
ALTER TABLE resources
  ADD COLUMN IF NOT EXISTS employee_id INT REFERENCES employees(id) ON DELETE SET NULL;

CREATE UNIQUE INDEX IF NOT EXISTS uniq_resources_employee_id
  ON resources(employee_id)
  WHERE employee_id IS NOT NULL;

-- ─── Seed: one resource per active employee ─────────────────────────────
-- Colors cycle through a 6-entry palette so distinct people get
-- distinct calendar bars without us hand-picking. Pure id-mod, so the
-- assignment is deterministic across re-runs of this migration on
-- different shops.
INSERT INTO resources (name, resource_type, daily_capacity_hours, color, notes, employee_id)
SELECT
  TRIM(CONCAT_WS(' ', e.first_name, e.last_name)) AS name,
  'person',
  8.0,
  (ARRAY['#0ea5e9','#22c55e','#a855f7','#f97316','#ec4899','#14b8a6'])[1 + (e.id % 6)],
  'Auto-synced from employees',
  e.id
FROM employees e
WHERE (e.active IS TRUE OR e.active IS NULL)
  AND NOT EXISTS (SELECT 1 FROM resources r WHERE r.employee_id = e.id)
  AND TRIM(CONCAT_WS(' ', e.first_name, e.last_name)) <> '';

-- ─── Detach templates from the old generic bucket ───────────────────────
-- After this, template steps that USED to default to Staff Assigned
-- have no default resource. Apply-template still copies their kind +
-- duration; staff pick the actual person on the resulting job_task.
UPDATE task_template_steps
   SET default_resource_id = NULL
 WHERE default_resource_id IN (SELECT id FROM resources WHERE name = 'Staff Assigned');

-- ─── Soft-retire the old bucket ─────────────────────────────────────────
UPDATE resources
   SET active = FALSE,
       notes  = COALESCE(notes, '') || ' (retired: per-employee resources replace this)'
 WHERE name = 'Staff Assigned';

-- ─── Keep resources in sync with employees ──────────────────────────────
-- On INSERT: create a matching person-resource for a new active employee.
-- On UPDATE: mirror name + active changes onto the linked resource so
--            renaming an employee or retiring them doesn't leave a
--            stale entry in the calendar.
CREATE OR REPLACE FUNCTION sync_employee_resource() RETURNS TRIGGER AS $$
DECLARE
  emp_name TEXT;
BEGIN
  emp_name := TRIM(CONCAT_WS(' ', NEW.first_name, NEW.last_name));

  IF TG_OP = 'INSERT' THEN
    IF (NEW.active IS TRUE OR NEW.active IS NULL)
       AND emp_name <> ''
       AND NOT EXISTS (SELECT 1 FROM resources WHERE employee_id = NEW.id)
    THEN
      INSERT INTO resources (name, resource_type, daily_capacity_hours, color, notes, employee_id)
      VALUES (
        emp_name, 'person', 8.0,
        (ARRAY['#0ea5e9','#22c55e','#a855f7','#f97316','#ec4899','#14b8a6'])[1 + (NEW.id % 6)],
        'Auto-synced from employees',
        NEW.id
      );
    END IF;
  ELSIF TG_OP = 'UPDATE' THEN
    -- Name change → mirror it on the resource.
    -- Active change → flip resource.active to match.
    UPDATE resources
       SET name   = CASE WHEN emp_name <> '' THEN emp_name ELSE name END,
           active = COALESCE(NEW.active, TRUE)
     WHERE employee_id = NEW.id;

    -- If the employee just became active and never had a resource
    -- (e.g. they predate this migration and were inactive at the
    -- time), create one now.
    IF (NEW.active IS TRUE OR NEW.active IS NULL)
       AND emp_name <> ''
       AND NOT EXISTS (SELECT 1 FROM resources WHERE employee_id = NEW.id)
    THEN
      INSERT INTO resources (name, resource_type, daily_capacity_hours, color, notes, employee_id)
      VALUES (
        emp_name, 'person', 8.0,
        (ARRAY['#0ea5e9','#22c55e','#a855f7','#f97316','#ec4899','#14b8a6'])[1 + (NEW.id % 6)],
        'Auto-synced from employees',
        NEW.id
      );
    END IF;
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_employee_to_resource_sync ON employees;
CREATE TRIGGER trg_employee_to_resource_sync
  AFTER INSERT OR UPDATE OF first_name, last_name, active ON employees
  FOR EACH ROW
  EXECUTE FUNCTION sync_employee_resource();

COMMIT;
