-- 050_drop_fordconnect.sql
-- Retire the consumer FordConnect integration (migration 048). Ford Pro
-- support directed us to the fleet-grade Ford Pro Telematics REST API
-- (migration 049, lib/fordpro-telematics.js), and FordConnect's FordPass
-- OAuth login was failing on Ford's side anyway (Azure B2C AADB2C90075 in
-- their own policy). The lib + route are deleted; this drops the now-unused
-- tables. No other code reads them, and the cached telemetry never populated
-- (the link never connected), so there's no data worth keeping.

BEGIN;

DROP TABLE IF EXISTS fordconnect_vehicles;   -- FK to fordconnect_links — drop first
DROP TABLE IF EXISTS fordconnect_links;

COMMIT;
