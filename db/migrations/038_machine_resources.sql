-- 038_machine_resources.sql
-- Replace the generic seeded machine resources with the shop's actual
-- equipment names, and add the second-of-each-pair machines:
--
--   CNC Machine          → CNC Laser
--   (new)                  CNC Router
--   Wide-Format Printer  → Mimaki CJV 33-160 #1
--   (new)                  Mimaki CJV 33-160 #2
--   Plotter              → HP210 24" Printer
--
-- Existing templates that referenced these resources by name at seed
-- time (Channel Letter, LED Display, Monument, Backlit Sign, Banner,
-- Vehicle Wrap, Window Graphics, Magnetic Signs, Vinyl Decal) stored
-- the resource's ID at insert time, so renaming is safe — every
-- template step keeps pointing at the same renamed row.
--
-- INSERT new resources only if the name doesn't already exist, so
-- re-running this on a shop that's already added them manually via
-- the admin UI is a no-op.

BEGIN;

-- ─── Renames ─────────────────────────────────────────────────────────
UPDATE resources
   SET name = 'CNC Laser'
 WHERE name = 'CNC Machine'
   AND NOT EXISTS (SELECT 1 FROM resources WHERE name = 'CNC Laser');

UPDATE resources
   SET name = 'Mimaki CJV 33-160 #1'
 WHERE name = 'Wide-Format Printer'
   AND NOT EXISTS (SELECT 1 FROM resources WHERE name = 'Mimaki CJV 33-160 #1');

UPDATE resources
   SET name = 'HP210 24" Printer'
 WHERE name = 'Plotter'
   AND NOT EXISTS (SELECT 1 FROM resources WHERE name = 'HP210 24" Printer');

-- ─── Additions ───────────────────────────────────────────────────────
-- CNC Router — second CNC station for materials the laser can't cut
-- (thicker aluminum, MDF, ACM). Same 8h/day capacity as the laser.
INSERT INTO resources (name, resource_type, daily_capacity_hours, color, notes)
SELECT 'CNC Router', 'machine', 8.0, '#6d28d9', 'CNC router — for materials the laser cannot cut'
WHERE NOT EXISTS (SELECT 1 FROM resources WHERE name = 'CNC Router');

-- Second Mimaki CJV 33-160 — matched pair, alternating print/cut load.
INSERT INTO resources (name, resource_type, daily_capacity_hours, color, notes)
SELECT 'Mimaki CJV 33-160 #2', 'machine', 8.0, '#f472b6', 'Second wide-format printer/cutter; load-shares with #1'
WHERE NOT EXISTS (SELECT 1 FROM resources WHERE name = 'Mimaki CJV 33-160 #2');

COMMIT;
