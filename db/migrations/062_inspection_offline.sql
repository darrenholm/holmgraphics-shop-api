-- 062_inspection_offline.sql
-- Offline capture for daily inspections (build spec §6).
--
-- Circle checks happen in yards with no signal. The driver still performs a
-- real inspection at a real time, and that time — not the moment the phone
-- finally reconnected — is what the report has to say. So an offline check
-- carries the client's clock, and the server records its own alongside it.
-- Both are kept, permanently and visibly: an auditor looking at a report
-- signed at 06:40 and received at 09:15 should be able to see exactly that,
-- rather than a single number that quietly means one or the other.
--
--   completed_at        the legal time of the inspection. For an online
--                       check this is the server clock. For a synced check
--                       it is the driver's clock, bounds-checked on arrival.
--   client_completed_at what the device said, kept raw even when it equals
--                       completed_at, so "this came from a device clock" is
--                       never inferred from an absence.
--   server_received_at  when the API actually got it.
--
-- client_uuid is the idempotency key, and it is the reason this is a column
-- and not just request handling: a phone that regains signal, POSTs, and
-- loses signal again before reading the response WILL retry. Without a
-- unique key that retry produces a second legal record of the same
-- inspection, which is worse than the sync having failed.
--
-- Safe to re-run.

ALTER TABLE inspections
  ADD COLUMN IF NOT EXISTS client_uuid         TEXT,
  ADD COLUMN IF NOT EXISTS client_completed_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS server_received_at  TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS completed_offline   BOOLEAN NOT NULL DEFAULT FALSE;

-- Partial, so the many online checks (which have no client_uuid) don't all
-- collide on NULL under a plain unique constraint.
CREATE UNIQUE INDEX IF NOT EXISTS uniq_inspections_client_uuid
  ON inspections (client_uuid) WHERE client_uuid IS NOT NULL;

-- An offline check must show its work: if it says it was completed offline,
-- both clocks have to be on the record.
ALTER TABLE inspections
  DROP CONSTRAINT IF EXISTS inspections_offline_has_both_clocks;
ALTER TABLE inspections
  ADD CONSTRAINT inspections_offline_has_both_clocks CHECK (
    completed_offline = FALSE OR (
      client_completed_at IS NOT NULL AND server_received_at IS NOT NULL
    )
  );

COMMENT ON COLUMN inspections.completed_at IS
  'Legal time of the inspection. Server clock for an online check; the '
  'driver''s device clock (bounds-checked) for one captured offline.';
COMMENT ON COLUMN inspections.client_uuid IS
  'Idempotency key for offline sync. A retried POST returns the existing '
  'report rather than writing a second record of the same inspection.';
