-- 078_modules_bin.sql
-- Storage bin / shelf location for a module.
--
-- The service desk workflow is: look up a sign → see which module it uses and
-- how many are on hand → go to the bin and pull the spare. The first two steps
-- already work (led_signs.module_id → modules.on_hand); this column adds the
-- bin so the whole lookup happens at the desk without walking to storage.
--
-- Free text (e.g. "B-14") — bins are labelled by hand, not a fixed scheme.
-- Safe to re-run.

ALTER TABLE modules
  ADD COLUMN IF NOT EXISTS bin TEXT;
