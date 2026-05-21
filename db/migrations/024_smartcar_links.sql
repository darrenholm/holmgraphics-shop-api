-- 024_smartcar_links.sql
-- Phase 2 of the fleet portal: Smartcar telematics integration.
--
-- Two new tables:
--   vehicle_smartcar_links       — one row per linked vehicle, stores
--                                  encrypted OAuth tokens + sync state
--   vehicle_location_snapshots   — append-only log of fetched locations
--                                  (and odometer/fuel when available)
--
-- Encryption: access_token + refresh_token are AES-256-GCM ciphertext
-- (see lib/encryption.js). Never store plaintext, never log decrypted
-- values. ENCRYPTION_KEY env var holds the key.
--
-- VIN match: the join from Smartcar → our fleet is by VIN (Smartcar's
-- canonical identifier per vehicle). The callback handler refuses to
-- create a link if no vehicle with that VIN exists in `vehicles` —
-- admins must add the vehicle first.
--
-- Safe to re-run.

CREATE TABLE IF NOT EXISTS vehicle_smartcar_links (
  id                   SERIAL PRIMARY KEY,
  vehicle_id           INT NOT NULL UNIQUE REFERENCES vehicles(id),
  smartcar_vehicle_id  TEXT NOT NULL UNIQUE,
  access_token         TEXT NOT NULL,                    -- encrypted
  refresh_token        TEXT NOT NULL,                    -- encrypted
  token_expires_at     TIMESTAMPTZ NOT NULL,
  connected_by         INT NOT NULL REFERENCES employees(id),
  connected_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_synced_at       TIMESTAMPTZ,
  last_error           TEXT,
  status               TEXT NOT NULL DEFAULT 'active'
                       CHECK (status IN ('active', 'revoked', 'error')),
  created_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS vehicle_smartcar_links_status_idx
  ON vehicle_smartcar_links (status);

CREATE OR REPLACE FUNCTION orders_set_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at := NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS vehicle_smartcar_links_updated_at_trigger ON vehicle_smartcar_links;
CREATE TRIGGER vehicle_smartcar_links_updated_at_trigger
  BEFORE UPDATE ON vehicle_smartcar_links
  FOR EACH ROW
  EXECUTE FUNCTION orders_set_updated_at();

-- ─── vehicle_location_snapshots ─────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS vehicle_location_snapshots (
  id                       BIGSERIAL PRIMARY KEY,
  vehicle_id               INT NOT NULL REFERENCES vehicles(id),
  latitude                 NUMERIC(10, 7) NOT NULL,
  longitude                NUMERIC(10, 7) NOT NULL,
  odometer_km              NUMERIC(10, 2),
  fuel_percent_remaining   NUMERIC(5, 2),
  fetched_at               TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  smartcar_timestamp       TIMESTAMPTZ,
  fetched_by               INT REFERENCES employees(id)
);

CREATE INDEX IF NOT EXISTS vehicle_location_snapshots_vehicle_idx
  ON vehicle_location_snapshots (vehicle_id, fetched_at DESC);

CREATE INDEX IF NOT EXISTS vehicle_location_snapshots_recent_idx
  ON vehicle_location_snapshots (fetched_at DESC);

-- 90-day pruning is handled in app code (no cron service yet); for now
-- the table grows. TODO: when a scheduler lands, add:
--   DELETE FROM vehicle_location_snapshots WHERE fetched_at < NOW() - INTERVAL '90 days'
