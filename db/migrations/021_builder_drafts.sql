-- 021_builder_drafts.sql
-- Decoration builder draft state. A draft is the buyer's in-progress order
-- in the new /shop/builder UI: garment selections, hotspot locations, roster,
-- and (eventually) artwork URLs. Drafts live until the buyer either:
--   * clicks "Submit for proof"  → status flips to 'submitted', admin gets
--     emailed, and the draft becomes the source of truth until the admin
--     manually creates a job/order on review.
--   * abandons the draft         → a cleanup cron flips abandoned drafts to
--     'abandoned' after 30 days idle (not yet implemented).
--
-- The full builder state lives in `state` JSONB so the schema doesn't have
-- to chase UI iterations. Once the builder UX stabilizes, frequently-queried
-- fields can be promoted to columns.
--
-- Auth model: session_token bearer auth. POST creates a draft and returns
-- the token; subsequent reads/writes/submits require it in the
-- `X-Builder-Session` header. JWT-based client linkage is left for a
-- follow-up — for v1, anonymous drafts are the common case.
--
-- Safe to re-run.

CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS builder_drafts (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  session_token   TEXT NOT NULL,
  client_id       INT REFERENCES clients(id) ON DELETE SET NULL,
  state           JSONB NOT NULL DEFAULT '{}'::JSONB,
  status          TEXT NOT NULL DEFAULT 'draft'
                  CHECK (status IN ('draft', 'submitted', 'abandoned')),
  contact_email   TEXT,
  contact_name    TEXT,
  contact_phone   TEXT,
  submitted_at    TIMESTAMPTZ,
  abandoned_at    TIMESTAMPTZ,
  notify_email_id TEXT,                                   -- Resend message id of the admin email
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS builder_drafts_session_idx
  ON builder_drafts (session_token);

CREATE INDEX IF NOT EXISTS builder_drafts_client_idx
  ON builder_drafts (client_id)
  WHERE client_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS builder_drafts_status_idx
  ON builder_drafts (status, updated_at DESC);

-- Reuse the trigger function created in 008_dtf_store_schema.sql. If that
-- migration hasn't run yet (e.g. fresh-bootstrap edge case), recreate it
-- here so this migration is self-contained.
CREATE OR REPLACE FUNCTION orders_set_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at := NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS builder_drafts_updated_at_trigger ON builder_drafts;
CREATE TRIGGER builder_drafts_updated_at_trigger
  BEFORE UPDATE ON builder_drafts
  FOR EACH ROW
  EXECUTE FUNCTION orders_set_updated_at();
