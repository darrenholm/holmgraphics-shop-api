-- 048_fordconnect.sql
-- FordConnect telematics integration. Two tables:
--
--   fordconnect_links     — one row per OAuth grant. A shop staffer signs
--                           into their FordPass account once; their refresh
--                           token unlocks every vehicle in their garage.
--                           Typically just one row per shop (the admin's
--                           FordPass account that owns all the trucks).
--
--   fordconnect_vehicles  — one row per VIN visible to that link.
--                           Auto-mapped to our fleet.vehicles by VIN when
--                           the user runs Sync. Holds the cached telemetry
--                           snapshot (location, odometer, fuel) so the
--                           UI is instant — we don't round-trip Ford on
--                           every page render.
--
-- The nightly cron (lib/fordconnect-sync.js) refreshes telemetry so the
-- odometer column stays current — that's what drives the lease-mileage
-- warnings on the finance card from migration 047.

BEGIN;

CREATE TABLE IF NOT EXISTS fordconnect_links (
  id              SERIAL PRIMARY KEY,
  -- Which staffer's FordPass we're using. NULL means "shop-owned" link
  -- (set up by an admin without attribution to a specific employee).
  employee_id     INT REFERENCES employees(id) ON DELETE SET NULL,
  access_token    TEXT NOT NULL,
  refresh_token   TEXT NOT NULL,
  -- access_token usually has ~1hr lifetime; refresh_token lasts much
  -- longer (90 days typical for Azure B2C with offline_access). The
  -- API wrapper auto-refreshes a few minutes before expiry.
  expires_at      TIMESTAMPTZ NOT NULL,
  scope           TEXT,
  -- Plain text "Connected" / "Token refresh failed: …". The last sync
  -- result so the UI can show why a link broke without digging in logs.
  last_status     TEXT,
  last_synced_at  TIMESTAMPTZ,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS fordconnect_vehicles (
  id                SERIAL PRIMARY KEY,
  link_id           INT NOT NULL REFERENCES fordconnect_links(id) ON DELETE CASCADE,
  -- Auto-mapped to vehicles.id when our VIN matches (Sync does the join).
  -- NULL when this Ford vehicle isn't in our fleet yet — the UI can
  -- offer "add to fleet" or "ignore" actions in that case.
  vehicle_id        INT REFERENCES vehicles(id) ON DELETE SET NULL,
  ford_vin          TEXT NOT NULL,
  ford_nickname     TEXT,
  make              TEXT,
  model             TEXT,
  year              INT,
  -- Cached telemetry snapshot. Updated by the sync job; the UI reads
  -- these without round-tripping Ford on every page load.
  last_location_lat NUMERIC(10, 7),
  last_location_lon NUMERIC(10, 7),
  last_location_at  TIMESTAMPTZ,
  last_odometer_km  NUMERIC(10, 1),
  last_odometer_at  TIMESTAMPTZ,
  last_fuel_pct     NUMERIC(5, 2),
  last_fetched_at   TIMESTAMPTZ,
  last_fetch_error  TEXT,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (link_id, ford_vin)
);
CREATE INDEX IF NOT EXISTS idx_fordconnect_vehicles_vehicle ON fordconnect_vehicles(vehicle_id);

DROP TRIGGER IF EXISTS trg_fordconnect_links_touch ON fordconnect_links;
CREATE TRIGGER trg_fordconnect_links_touch BEFORE UPDATE ON fordconnect_links
  FOR EACH ROW EXECUTE FUNCTION touch_updated_at();

DROP TRIGGER IF EXISTS trg_fordconnect_vehicles_touch ON fordconnect_vehicles;
CREATE TRIGGER trg_fordconnect_vehicles_touch BEFORE UPDATE ON fordconnect_vehicles
  FOR EACH ROW EXECUTE FUNCTION touch_updated_at();

COMMIT;
