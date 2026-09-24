-- Give every road unit an inspection schedule.
--
-- 060 and 063 pointed the trucks and trailers that existed at the time at
-- Schedule 1, but nothing assigned a schedule to a unit added afterwards.
-- The 2026 F-250 (T-05) came in that way and the circle check refused it:
-- "This unit has no inspection schedule assigned."
--
-- POST /vehicles now assigns the active Schedule 1 on create, and the admin
-- vehicle page can change it. This catches up the units already missing one.
-- Equipment is left alone — O. Reg. 199/07 does not reach a scissor lift
-- (see 071).
--
-- Safe to re-run.

UPDATE vehicles v
   SET inspection_schedule_id = s.id
  FROM (
    SELECT id FROM inspection_schedules
     WHERE name = 'Schedule 1 — Power Unit' AND active = TRUE
     ORDER BY version DESC
     LIMIT 1
  ) s
 WHERE v.active = TRUE
   AND v.type IN ('truck', 'trailer')
   AND v.inspection_schedule_id IS NULL;
