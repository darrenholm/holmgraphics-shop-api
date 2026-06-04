-- 042_task_assignees.sql
-- Per-task multi-assignee support. job_tasks.assigned_emp_id stays as
-- the "primary / lead" assignee (no schema change to the existing
-- column) and additional helpers are recorded in job_task_assignees
-- with a role label ('lead' on the primary so a single query can
-- enumerate all assignees uniformly).
--
-- A trigger keeps a "lead" row in job_task_assignees in sync with
-- job_tasks.assigned_emp_id so the union-of-assignees view doesn't
-- have to read two sources.

BEGIN;

CREATE TABLE IF NOT EXISTS job_task_assignees (
  task_id     INT NOT NULL REFERENCES job_tasks(id) ON DELETE CASCADE,
  employee_id INT NOT NULL REFERENCES employees(id),
  role        TEXT NOT NULL DEFAULT 'assist'
    CHECK (role IN ('lead', 'assist')),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (task_id, employee_id)
);

CREATE INDEX IF NOT EXISTS idx_task_assignees_employee
  ON job_task_assignees(employee_id);

-- Backfill: every existing task with an assigned_emp_id gets a 'lead'
-- row in job_task_assignees so the calendar's lane-union sees a single
-- consistent source.
INSERT INTO job_task_assignees (task_id, employee_id, role)
SELECT id, assigned_emp_id, 'lead'
  FROM job_tasks
 WHERE assigned_emp_id IS NOT NULL
ON CONFLICT (task_id, employee_id) DO NOTHING;

-- Keep job_tasks.assigned_emp_id and job_task_assignees in sync.
-- When job_tasks.assigned_emp_id changes:
--   • The previous lead row (if any) gets demoted to assist or
--     deleted entirely (we go with delete: cleaner, and the user can
--     re-add them as assist via the UI if they want).
--   • A new lead row is created for the new assignee (or upgraded
--     from assist if they were already on the task).
CREATE OR REPLACE FUNCTION sync_task_lead_assignee() RETURNS TRIGGER AS $$
BEGIN
  -- Drop the previous lead row when the assignee actually changes.
  IF TG_OP = 'UPDATE'
     AND OLD.assigned_emp_id IS DISTINCT FROM NEW.assigned_emp_id
     AND OLD.assigned_emp_id IS NOT NULL
  THEN
    DELETE FROM job_task_assignees
     WHERE task_id = NEW.id
       AND employee_id = OLD.assigned_emp_id
       AND role = 'lead';
  END IF;

  IF NEW.assigned_emp_id IS NOT NULL THEN
    -- Insert as lead, or promote an existing assist row.
    INSERT INTO job_task_assignees (task_id, employee_id, role)
    VALUES (NEW.id, NEW.assigned_emp_id, 'lead')
    ON CONFLICT (task_id, employee_id)
    DO UPDATE SET role = 'lead';
  END IF;

  RETURN NEW;
END $$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_job_task_lead_sync ON job_tasks;
CREATE TRIGGER trg_job_task_lead_sync
  AFTER INSERT OR UPDATE OF assigned_emp_id ON job_tasks
  FOR EACH ROW
  EXECUTE FUNCTION sync_task_lead_assignee();

COMMIT;
