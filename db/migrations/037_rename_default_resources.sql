-- 037_rename_default_resources.sql
-- Tidies the default seed resources to match shop terminology + capabilities:
--   Install Crew 1 → Staff Assigned
--   Install Crew 2 → soft-retire (set active=FALSE) since "Staff Assigned"
--                    is a single bucket — the actual person comes from
--                    each task's assigned_emp_id, not a crew slot
--   Crane Day      → Skyjack
--   Paint Booth    → soft-retire (shop doesn't paint in-house). Also
--                    nulls out the default_resource_id on any template
--                    step that pointed at it so future template applies
--                    don't auto-assign a retired resource.
--
-- Resources are referenced by ID from job_tasks.resource_id,
-- task_template_steps.default_resource_id, and
-- project_install_schedule.crew_resource_id — so UPDATEing the name
-- column is safe, no cascade required. Anything seeded by 035 or 036
-- that pointed at "Crane Day" by id still points at the same row,
-- which now happens to be named "Skyjack".
--
-- Each UPDATE is no-op if the target name already exists (e.g. the
-- migration is being re-applied after a manual rename in the admin
-- UI), so this is safe to run on any state.

BEGIN;

-- Skip the rename when the new name already exists, to avoid a unique-
-- ish collision if the user renamed manually first. (resources.name
-- isn't actually UNIQUE in the schema, but having two rows named
-- "Skyjack" would look weird in the dropdown.)

UPDATE resources
   SET name = 'Staff Assigned'
 WHERE name = 'Install Crew 1'
   AND NOT EXISTS (SELECT 1 FROM resources WHERE name = 'Staff Assigned');

-- Retire Install Crew 2 — the "Staff Assigned" bucket replaces both.
-- Soft-delete (active=FALSE) so any prior references stay intact;
-- the calendar / dropdowns filter to active rows by default.
UPDATE resources
   SET active = FALSE,
       notes  = COALESCE(notes, '') || ' (retired: collapsed into Staff Assigned)'
 WHERE name = 'Install Crew 2';

UPDATE resources
   SET name = 'Skyjack'
 WHERE name = 'Crane Day'
   AND NOT EXISTS (SELECT 1 FROM resources WHERE name = 'Skyjack');

-- Detach the Paint Booth from any template step that referenced it as
-- default. Has to happen before we retire the resource itself, so the
-- UI doesn't show "default: Paint Booth (inactive)" on those steps.
UPDATE task_template_steps
   SET default_resource_id = NULL
 WHERE default_resource_id IN (SELECT id FROM resources WHERE name = 'Paint Booth');

-- Soft-retire Paint Booth (preserves any historical job_tasks /
-- install_schedule references). Dropdowns / calendar filter to
-- active=TRUE, so it disappears from the UI immediately.
UPDATE resources
   SET active = FALSE,
       notes  = COALESCE(notes, '') || ' (retired: shop does not paint in-house)'
 WHERE name = 'Paint Booth';

COMMIT;
