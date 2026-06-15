-- 049_fordpro_telematics.sql
-- Ford Pro Telematics REST API (api.fordpro.com) — fleet-grade, machine-to-
-- machine telematics. This is the product Ford Pro support steered us to for
-- live polling (case 01886258); it supersedes the consumer FordConnect
-- integration (migration 048), but runs ALONGSIDE it for now.
--
-- Unlike FordConnect there's no per-user OAuth grant — auth is a single
-- service account using the client-credentials grant, so there's no links
-- table. One snapshot row per Ford Pro vehicle, refreshed by the poller
-- (lib/fordpro-telematics.js) every FORD_TELEMATICS_POLL_MINUTES. Vehicles
-- auto-map to our fleet.vehicles (migration 023) by VIN.

BEGIN;

CREATE TABLE IF NOT EXISTS fordpro_vehicles (
  id                  SERIAL PRIMARY KEY,
  -- Ford Pro's non-sensitive vehicle identifier (from GET /v3/vehicles).
  -- This is the upsert key, not the VIN.
  ford_vehicle_id     TEXT NOT NULL UNIQUE,
  ford_vin            TEXT NOT NULL,
  -- Auto-mapped to vehicles.id when the VIN matches one of ours; NULL until
  -- the truck is added to the fleet.
  vehicle_id          INT REFERENCES vehicles(id) ON DELETE SET NULL,
  make                TEXT,
  model               TEXT,
  year                INT,
  -- Cached telemetry snapshot (GET /v5/vehicles/:id/status). The dashboard
  -- reads these without round-tripping Ford on every render.
  last_location_lat   NUMERIC(10, 7),
  last_location_lon   NUMERIC(10, 7),
  last_location_at    TIMESTAMPTZ,
  last_odometer_km    NUMERIC(10, 1),
  last_odometer_at    TIMESTAMPTZ,
  last_fuel_pct       NUMERIC(5, 2),
  last_ignition       TEXT,                 -- e.g. 'ON' / 'OFF' / 'RUN'
  last_battery_volts  NUMERIC(5, 2),        -- 12V battery
  last_ev_soc_pct     NUMERIC(5, 2),        -- EV high-voltage state of charge (future EVs)
  last_ev_range_km    NUMERIC(10, 1),
  last_fetched_at     TIMESTAMPTZ,
  last_fetch_error    TEXT,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_fordpro_vehicles_vehicle ON fordpro_vehicles(vehicle_id);

DROP TRIGGER IF EXISTS trg_fordpro_vehicles_touch ON fordpro_vehicles;
CREATE TRIGGER trg_fordpro_vehicles_touch BEFORE UPDATE ON fordpro_vehicles
  FOR EACH ROW EXECUTE FUNCTION touch_updated_at();   -- defined in migration 035

-- Single-row poll state so the UI can show "last polled / status" without a
-- per-vehicle aggregate. id is pinned to 1.
CREATE TABLE IF NOT EXISTS fordpro_poll_state (
  id              INT PRIMARY KEY DEFAULT 1,
  last_polled_at  TIMESTAMPTZ,
  last_status     TEXT,
  CONSTRAINT fordpro_poll_state_singleton CHECK (id = 1)
);
INSERT INTO fordpro_poll_state (id) VALUES (1) ON CONFLICT (id) DO NOTHING;

COMMIT;
