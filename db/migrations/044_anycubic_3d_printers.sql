-- 044_anycubic_3d_printers.sql
-- Add the two shop 3D printers to the scheduling resources so they
-- appear as their own swimlanes on the install calendar. Numbered 1
-- and 3 (not 1 and 2) to match the actual unit labels on the floor.

BEGIN;

INSERT INTO resources (name, resource_type, daily_capacity_hours, color, notes)
SELECT 'Anycubic 1', 'machine', 8.0, '#14b8a6', 'Anycubic 3D printer — unit 1'
 WHERE NOT EXISTS (SELECT 1 FROM resources WHERE name = 'Anycubic 1');

INSERT INTO resources (name, resource_type, daily_capacity_hours, color, notes)
SELECT 'Anycubic 3', 'machine', 8.0, '#0d9488', 'Anycubic 3D printer — unit 3'
 WHERE NOT EXISTS (SELECT 1 FROM resources WHERE name = 'Anycubic 3');

COMMIT;
