-- 046_media_inventory.sql
-- Phase 1 of the inventory + PO system: media products (SKUs) and
-- physical roll instances, with a diameter→remaining-yardage formula
-- driven by per-SKU calibration.
--
-- Formula (calibration cancels out the per-layer thickness):
--   remaining_yd = full_length_yd * (D_now² - D_core²) / (D_new² - D_core²)
--
-- Where D_new is the outer diameter of a brand-new roll measured the
-- day it arrived. That measurement is stored on media_products as the
-- calibration — every roll of the same SKU then only needs an outer
-- diameter to compute remaining yards.
--
-- Measurement history is captured in media_roll_measurements so
-- consumption rate can be charted later. The roll row carries the
-- most-recent reading as a denormalisation for fast list rendering.

BEGIN;

-- ─── Products (the SKU catalog) ─────────────────────────────────────────
CREATE TABLE IF NOT EXISTS media_products (
  id                            SERIAL PRIMARY KEY,
  sku                           TEXT UNIQUE,
  brand                         TEXT,
  product_line                  TEXT,
  color                         TEXT,
  finish                        TEXT,
  -- Width (inches) is what determines material cost per linear yard.
  -- Numeric is fine because some fractional widths exist (15.5", etc.).
  width_in                      NUMERIC(6,3),
  -- Core diameter (inches). Common values are 2.0 and 3.0.
  core_diameter_in              NUMERIC(6,3) NOT NULL DEFAULT 3.0,
  -- Length per new roll (yards), from the spec sheet. The calibration
  -- measurement is what makes this number gospel for the math even if
  -- the spec is slightly off.
  full_length_yd                NUMERIC(8,2) NOT NULL,
  -- The measured outer diameter of a brand-new full roll. Inches.
  -- NULL until staff calibrates against a real roll. The roll-remaining
  -- view returns NULL on uncalibrated SKUs so the UI can prompt for it.
  calibration_outer_diameter_in NUMERIC(6,3),
  -- Reorder alert threshold (yards). Roll inventory below this for the
  -- SKU triggers a "low stock" badge on the dashboard.
  reorder_threshold_yd          NUMERIC(8,2),
  supplier                      TEXT,
  supplier_sku                  TEXT,
  notes                         TEXT,
  active                        BOOLEAN NOT NULL DEFAULT TRUE,
  created_at                    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at                    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  -- Catch divide-by-zero before the formula runs.
  CONSTRAINT positive_full_length CHECK (full_length_yd > 0),
  CONSTRAINT calibration_above_core
    CHECK (calibration_outer_diameter_in IS NULL
        OR calibration_outer_diameter_in > core_diameter_in)
);
CREATE INDEX IF NOT EXISTS idx_media_products_active ON media_products(active) WHERE active;

-- ─── Rolls (per-physical-instance state) ────────────────────────────────
CREATE TABLE IF NOT EXISTS media_rolls (
  id                       SERIAL PRIMARY KEY,
  product_id               INT NOT NULL REFERENCES media_products(id),
  -- Optional human-readable label (e.g. "R-142" or whatever the shop
  -- writes on the core tag with a Sharpie).
  roll_label               TEXT,
  -- Where to find it ("Rack A-3", "Vinyl wall", "Truck").
  location                 TEXT,
  -- Most-recent measurement, denormalised for fast list queries. The
  -- canonical history lives in media_roll_measurements.
  last_measured_dia_in     NUMERIC(6,3),
  last_measured_at         TIMESTAMPTZ,
  last_measured_by         INT REFERENCES employees(id),
  status                   TEXT NOT NULL DEFAULT 'active'
    CHECK (status IN ('active', 'depleted', 'damaged', 'retired')),
  notes                    TEXT,
  created_at               TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at               TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_media_rolls_product ON media_rolls(product_id);
CREATE INDEX IF NOT EXISTS idx_media_rolls_status  ON media_rolls(status);

-- Touch trigger (reuses touch_updated_at from migration 035).
DROP TRIGGER IF EXISTS trg_media_products_touch ON media_products;
CREATE TRIGGER trg_media_products_touch BEFORE UPDATE ON media_products
  FOR EACH ROW EXECUTE FUNCTION touch_updated_at();

DROP TRIGGER IF EXISTS trg_media_rolls_touch ON media_rolls;
CREATE TRIGGER trg_media_rolls_touch BEFORE UPDATE ON media_rolls
  FOR EACH ROW EXECUTE FUNCTION touch_updated_at();

-- ─── Measurement history ───────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS media_roll_measurements (
  id                   SERIAL PRIMARY KEY,
  roll_id              INT NOT NULL REFERENCES media_rolls(id) ON DELETE CASCADE,
  measured_dia_in      NUMERIC(6,3) NOT NULL,
  -- Yardage snapshot computed AT measurement time. Cached so historical
  -- consumption rates survive even if the parent product's calibration
  -- is later updated.
  computed_remaining_yd NUMERIC(8,2),
  measured_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  measured_by          INT REFERENCES employees(id),
  notes                TEXT
);
CREATE INDEX IF NOT EXISTS idx_roll_measurements_roll_time
  ON media_roll_measurements(roll_id, measured_at DESC);

-- ─── View: rolls with computed remaining yards ─────────────────────────
-- Joins each roll to its product and applies the formula. Returns NULL
-- in remaining_yd when the SKU hasn't been calibrated yet or when the
-- roll hasn't been measured — both states the UI should flag.
CREATE OR REPLACE VIEW media_rolls_with_remaining AS
SELECT
  r.id, r.product_id, r.roll_label, r.location, r.status, r.notes,
  r.last_measured_dia_in,
  r.last_measured_at,
  r.last_measured_by,
  r.created_at, r.updated_at,
  p.sku, p.brand, p.product_line, p.color, p.finish,
  p.width_in, p.core_diameter_in, p.full_length_yd,
  p.calibration_outer_diameter_in,
  p.reorder_threshold_yd,
  CASE
    WHEN r.last_measured_dia_in IS NULL                THEN NULL
    WHEN p.calibration_outer_diameter_in IS NULL       THEN NULL
    WHEN r.last_measured_dia_in <= p.core_diameter_in  THEN 0
    ELSE
      ROUND(
        p.full_length_yd
        * (POWER(r.last_measured_dia_in, 2)        - POWER(p.core_diameter_in, 2))
        / NULLIF(POWER(p.calibration_outer_diameter_in, 2) - POWER(p.core_diameter_in, 2), 0),
        2
      )
  END AS remaining_yd
FROM media_rolls r
JOIN media_products p ON p.id = r.product_id;

COMMIT;
