-- 036_backlit_sign_template.sql
-- Adds a "Backlit Sign" task template — acrylic / polycarb face with
-- LED backlighting in an aluminum or wood cabinet. Sits between
-- "Channel Letter Sign" (more complex, individually-lit letters) and
-- "LED Display" (RGB pixel array) in production complexity.
--
-- Typical flow:
--   Design → customer proof → order acrylic + LED strips (vendor wait)
--   → CNC face + cabinet → print/apply face graphics → LED wiring +
--   assembly → install. Crane is optional — most backlits are
--   building-mounted and the standard install crew can handle them;
--   staff can swap the install step's resource on a per-job basis.
--
-- Re-runnable: guarded by ON CONFLICT DO NOTHING the same way the
-- seeds in migration 035 are, so re-running on a shop that's already
-- customised this template is safe.

BEGIN;

INSERT INTO task_templates (name, notes) VALUES
  ('Backlit Sign', 'Acrylic / polycarb face, LED-illuminated cabinet')
ON CONFLICT DO NOTHING;

WITH t AS (SELECT id FROM task_templates WHERE name = 'Backlit Sign' LIMIT 1)
INSERT INTO task_template_steps
  (template_id, step_order, name, default_duration_days, default_resource_id, depends_on_order, task_kind, notes)
SELECT t.id, s.* FROM t,
  (VALUES
    (10, 'Design',                  2.0::numeric,
        NULL::int, NULL, 'labor',
        'Layout w/ visibility check — colors that read well when lit'),
    (20, 'Customer proof',          2.0::numeric,
        NULL::int, 10, 'customer_wait',
        NULL),
    (30, 'Order acrylic + LEDs',   10.0::numeric,
        NULL::int, 20, 'vendor_wait',
        'Acrylic face stock + LED strip — typical 1-2 week lead'),
    (40, 'CNC face + cabinet',      2.0::numeric,
        (SELECT id FROM resources WHERE name='CNC Machine' LIMIT 1),
        30, 'labor',
        'Route acrylic face, cut aluminum cabinet parts'),
    (50, 'Print + apply face graphics', 1.0::numeric,
        (SELECT id FROM resources WHERE name='Wide-Format Printer' LIMIT 1),
        40, 'labor',
        'Translucent print or vinyl overlay on acrylic'),
    (60, 'LED wiring + assembly',   1.0::numeric,
        NULL::int, 50, 'labor',
        'Wire LEDs, test illumination, close cabinet'),
    (70, 'Install',                 1.0::numeric,
        (SELECT id FROM resources WHERE name='Install Crew 1' LIMIT 1),
        60, 'labor',
        'Most backlit installs are building-mounted; switch to Crane Day for monument/pylon-mounted backlit signs')
  ) s(step_order, name, default_duration_days, default_resource_id, depends_on_order, task_kind, notes)
ON CONFLICT DO NOTHING;

COMMIT;
