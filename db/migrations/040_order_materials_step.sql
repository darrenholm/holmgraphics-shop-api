-- 040_order_materials_step.sql
-- Insert an "Order materials" step (vendor_wait) into the templates
-- where ordering inventory before customer approval has historically
-- been a problem. The step gates downstream production on the order
-- actually arriving — not just on the customer signing off the proof.
--
-- Templates touched:
--   Channel Letter Sign — order at step 25 (between proof @ 20 and
--                         permit @ 30). CNC at 40 now depends on 25
--                         rather than 20.
--   Monument / Pylon    — order at step 25 (between engineer stamp
--                         @ 20 and fabricate @ 30). Fab now depends
--                         on 25.
--   Vehicle Wrap        — order at step 35 (between proof @ 30 and
--                         print @ 40). Print now depends on 35.
--
-- LED Display and Backlit Sign already have explicit order steps
-- ("Order modules (vendor)", "Order acrylic + LEDs") — left alone.
-- The lighter templates (Vinyl Decal, Banner, Window Graphics,
-- Magnetic Signs) run from stock most of the time; staff can add an
-- Order Materials ad-hoc step on any specific job that needs it.
--
-- Re-runnable: guarded with NOT EXISTS lookups on (template_id,
-- step_order) so a second apply is a no-op even after manual edits
-- to the dependency chain.

BEGIN;

-- Helper note: each block (a) inserts the new step if not present,
-- then (b) rewires the immediately-downstream production step's
-- depends_on_order so it waits on the order. The rewires are
-- targeted by (template_id, step_order) so a step renumbering done
-- via the admin UI won't accidentally collide.

-- ─── Channel Letter Sign ────────────────────────────────────────────
INSERT INTO task_template_steps
  (template_id, step_order, name, default_duration_days, default_resource_id, depends_on_order, task_kind, notes)
SELECT t.id, 25, 'Order materials',
       5.0::numeric, NULL, 20, 'vendor_wait',
       'Acrylic faces, aluminum returns, LED modules — gated on customer approval'
  FROM task_templates t
 WHERE t.name = 'Channel Letter Sign'
   AND NOT EXISTS (
     SELECT 1 FROM task_template_steps s
      WHERE s.template_id = t.id AND s.step_order = 25
   );

UPDATE task_template_steps
   SET depends_on_order = 25
 WHERE template_id = (SELECT id FROM task_templates WHERE name = 'Channel Letter Sign')
   AND step_order = 40                   -- CNC cut step
   AND depends_on_order = 20;

-- ─── Monument / Pylon ───────────────────────────────────────────────
INSERT INTO task_template_steps
  (template_id, step_order, name, default_duration_days, default_resource_id, depends_on_order, task_kind, notes)
SELECT t.id, 25, 'Order materials',
       5.0::numeric, NULL, 20, 'vendor_wait',
       'Sheet aluminum, post stock, hardware — gated on engineer stamp'
  FROM task_templates t
 WHERE t.name = 'Monument / Pylon'
   AND NOT EXISTS (
     SELECT 1 FROM task_template_steps s
      WHERE s.template_id = t.id AND s.step_order = 25
   );

UPDATE task_template_steps
   SET depends_on_order = 25
 WHERE template_id = (SELECT id FROM task_templates WHERE name = 'Monument / Pylon')
   AND step_order = 30                   -- Fabricate step
   AND depends_on_order = 20;

-- ─── Vehicle Wrap ───────────────────────────────────────────────────
INSERT INTO task_template_steps
  (template_id, step_order, name, default_duration_days, default_resource_id, depends_on_order, task_kind, notes)
SELECT t.id, 35, 'Order materials',
       3.0::numeric, NULL, 30, 'vendor_wait',
       'Wrap film + laminate in the proofed colours — gated on customer approval'
  FROM task_templates t
 WHERE t.name = 'Vehicle Wrap'
   AND NOT EXISTS (
     SELECT 1 FROM task_template_steps s
      WHERE s.template_id = t.id AND s.step_order = 35
   );

UPDATE task_template_steps
   SET depends_on_order = 35
 WHERE template_id = (SELECT id FROM task_templates WHERE name = 'Vehicle Wrap')
   AND step_order = 40                   -- Print step
   AND depends_on_order = 30;

COMMIT;
