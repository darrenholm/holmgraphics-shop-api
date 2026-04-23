-- 005_modules_link_and_stock.sql
-- Two small additions to support the "Modules" tab on the job detail page:
--
--   1. modules.on_hand — current physical stock count (nullable so unknown
--      stays unknown instead of falsely reading "0").
--
--   2. led_signs.module_id — FK link from a sign to the modules inventory
--      row it uses. Most signs have a unique module; sometimes two signs
--      ordered together share one module row, so this is many-to-one
--      (signs → module), NOT unique.
--
-- NOTE: led_signs.module_size (e.g. "P10 192x192") stays as a free-text
-- label and is intentionally NOT the same thing as modules.module_id_no.
--
-- Safe to re-run.

ALTER TABLE modules
  ADD COLUMN IF NOT EXISTS on_hand INTEGER;

ALTER TABLE led_signs
  ADD COLUMN IF NOT EXISTS module_id INTEGER
    REFERENCES modules(id) ON DELETE SET NULL;

-- Speeds up "which signs use this module" lookups for the modules tab and
-- the (future) admin inventory page.
CREATE INDEX IF NOT EXISTS led_signs_module_id_idx
  ON led_signs (module_id)
  WHERE module_id IS NOT NULL;
