-- 076_module_inventory.sql
-- Shop-wide LED module shelf inventory (the /modules page on the frontend).
--
-- One `modules` row is still one PART NUMBER, not one physical module:
-- signs built from the same production run share a part number, so the
-- row carries a count (on_hand) and any number of led_signs point at it
-- via led_signs.module_id. Signs from their own run get their own row.
--
-- Added here so ~400 shelf modules can be found and labelled:
--   description     free text, e.g. "P10 outdoor 320x160, Novastar"
--   shelf_location  where the box sits, e.g. "Rack B / Shelf 3"
--   notes           anything else (supplier, batch date, condition)
--   last_counted_at when on_hand was last set by a physical count
--
-- module_id_no is deliberately NOT made unique here: the 13 rows carried
-- over from Azure were never checked for duplicates, and a failing unique
-- index would block every later migration on boot. The API refuses new
-- duplicates instead (POST/PUT /clients/modules → 409).
--
-- Safe to re-run.

ALTER TABLE modules ADD COLUMN IF NOT EXISTS description     VARCHAR(255);
ALTER TABLE modules ADD COLUMN IF NOT EXISTS shelf_location  VARCHAR(120);
ALTER TABLE modules ADD COLUMN IF NOT EXISTS notes           TEXT;
ALTER TABLE modules ADD COLUMN IF NOT EXISTS last_counted_at TIMESTAMPTZ;

-- Case/space-insensitive lookup for the duplicate check and for the
-- search box on the inventory page.
CREATE INDEX IF NOT EXISTS modules_module_id_no_norm_idx
  ON modules (LOWER(TRIM(module_id_no)));
