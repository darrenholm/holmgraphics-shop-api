-- 025_smartcar_v3.sql
-- Migrate Smartcar integration to V3 (Connect 2.0 / iam.smartcar.com).
--
-- V3 architecture is different from V2:
--   * No per-user OAuth access_token / refresh_token. Authentication is
--     M2M (`grant_type=client_credentials` at iam.smartcar.com) — one
--     access token per APPLICATION, cached for ~1h.
--   * Per-vehicle data is accessed via `vehicle.api.smartcar.com/v3/...`
--     with the M2M token + `sc-user-id` header to scope to a single
--     user (the Smartcar user who authorized the vehicle).
--
-- Schema changes:
--   * Add sc_user_id (TEXT) — the Smartcar user identifier returned by
--     the /v3/connections endpoint. Required for all per-vehicle calls.
--   * Drop NOT NULL constraints on access_token / refresh_token /
--     token_expires_at — those columns are unused in V3 (kept for
--     historical data compatibility; null on new V3-era links).
--
-- Safe to re-run.

ALTER TABLE vehicle_smartcar_links
  ADD COLUMN IF NOT EXISTS sc_user_id TEXT;

ALTER TABLE vehicle_smartcar_links
  ALTER COLUMN access_token     DROP NOT NULL,
  ALTER COLUMN refresh_token    DROP NOT NULL,
  ALTER COLUMN token_expires_at DROP NOT NULL;

CREATE INDEX IF NOT EXISTS vehicle_smartcar_links_user_idx
  ON vehicle_smartcar_links (sc_user_id)
  WHERE sc_user_id IS NOT NULL;
