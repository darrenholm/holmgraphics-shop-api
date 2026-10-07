-- 080_inspection_not_applicable.sql
--
-- Lets a circle check say "this Part does not apply" instead of forcing the
-- driver to mark Air Brake System "All OK" on a truck that has no air brakes.
-- Schedule 1 covers every kind of truck, tractor and trailer, so most units
-- only carry some of its 23 Parts.
--
-- Two sources, kept apart on the report so an audit can tell them apart:
--
--   vehicles.inspection_na_groups   set by an admin per unit: the systems
--                                   this unit is not fitted with. Those Parts
--                                   are hidden from the driver's check.
--   inspections.not_fitted_groups   snapshot of the above at signing. When a
--                                   trailer is drawn, only Parts that NEITHER
--                                   unit has are hidden — a pickup with no
--                                   electric brakes towing a trailer that has
--                                   them still gets Electric Brake System.
--   inspections.na_groups           Parts the DRIVER marked N/A on this check.
--
-- Values are schedule group names (e.g. 'Air Brake System'), matching how the
-- check screen groups the schedule. Both inspection columns are frozen by the
-- whole-row immutability trigger from 060 with no change needed there.
--
-- Safe to re-run.

ALTER TABLE vehicles
  ADD COLUMN IF NOT EXISTS inspection_na_groups TEXT[] NOT NULL DEFAULT '{}';

ALTER TABLE inspections
  ADD COLUMN IF NOT EXISTS not_fitted_groups TEXT[] NOT NULL DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS na_groups         TEXT[] NOT NULL DEFAULT '{}';
