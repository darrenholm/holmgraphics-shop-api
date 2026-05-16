-- 019_led_modules.sql
-- Spec catalog of LED display modules, used by the LED Sign Quoting tool
-- (/admin/led-quote on the frontend).
--
-- DISTINCT from the existing `modules` table: that one tracks
-- per-client-sign inventory counts (module_id_no, on_hand). This table
-- is a shared catalog of module *types* (320x160 P8, 192x192 P10, etc.)
-- with the dimensional + electrical specs needed to compute area, pixel
-- resolution, max power draw, and price for a quote.
--
-- Numerics, not integers: real-world LED modules ship with fractional
-- pixel pitches (P2.5, P3.91, P6.67) and the prototype calc uses floats.
--
-- Soft delete via is_active so historic quote descriptions still resolve
-- the module name long after it's been retired from the dropdown.

CREATE TABLE IF NOT EXISTS led_modules (
  id              INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  name            VARCHAR(120) NOT NULL,
  width_mm        NUMERIC(8,2) NOT NULL CHECK (width_mm  > 0),
  height_mm       NUMERIC(8,2) NOT NULL CHECK (height_mm > 0),
  pitch_mm        NUMERIC(6,2) NOT NULL CHECK (pitch_mm  > 0),
  max_watts       NUMERIC(8,2) NOT NULL CHECK (max_watts > 0),
  control_system  VARCHAR(120),
  is_active       BOOLEAN     NOT NULL DEFAULT TRUE,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_led_modules_active
  ON led_modules (is_active) WHERE is_active = TRUE;

-- Auto-bump updated_at on UPDATE (matches pay_periods / clients pattern).
CREATE OR REPLACE FUNCTION led_modules_set_updated_at()
RETURNS TRIGGER AS $$
BEGIN NEW.updated_at := NOW(); RETURN NEW; END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS led_modules_updated_at_trigger ON led_modules;
CREATE TRIGGER led_modules_updated_at_trigger
  BEFORE UPDATE ON led_modules FOR EACH ROW
  EXECUTE FUNCTION led_modules_set_updated_at();

-- Seed the P8 320x160 module used on the Kincardine job. Idempotent —
-- only seeds on first apply when the table is empty, so subsequent runs
-- don't reintroduce a row an admin may have intentionally deleted.
INSERT INTO led_modules (name, width_mm, height_mm, pitch_mm, max_watts, control_system)
SELECT 'P8 Outdoor — 320x160', 320, 160, 8, 36, 'Novastar T-30'
WHERE NOT EXISTS (SELECT 1 FROM led_modules);
