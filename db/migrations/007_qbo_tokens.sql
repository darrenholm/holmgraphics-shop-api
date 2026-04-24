-- 007_qbo_tokens.sql
-- Persist QuickBooks Online OAuth tokens to Postgres.
--
-- Background: routes/quickbooks.js originally kept tokens in process memory,
-- which meant every Railway redeploy silently disconnected QBO and required
-- a manual re-click of the Connect button. Persisting to DB fixes that and
-- enables the new DTF online store to charge customers via QB Payments
-- without losing the connection on every deploy.
--
-- Singleton-ish: keyed by realm_id, so multi-company support comes for free
-- if Holm Graphics ever connects a second QBO company. The current code
-- treats whichever row exists as "the" connected company.
--
-- The `scopes` column tracks which OAuth scopes were granted so the app
-- knows whether to prompt for re-authorization when a new feature requires
-- a broader scope (e.g. adding com.intuit.quickbooks.payment).
--
-- Safe to re-run.

CREATE TABLE IF NOT EXISTS qbo_tokens (
  realm_id      TEXT        PRIMARY KEY,
  access_token  TEXT        NOT NULL,
  refresh_token TEXT        NOT NULL,
  expires_at    TIMESTAMPTZ NOT NULL,
  scopes        TEXT        NOT NULL DEFAULT 'com.intuit.quickbooks.accounting',
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Auto-bump updated_at on every UPDATE.
CREATE OR REPLACE FUNCTION qbo_tokens_set_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at := NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS qbo_tokens_updated_at_trigger ON qbo_tokens;
CREATE TRIGGER qbo_tokens_updated_at_trigger
  BEFORE UPDATE ON qbo_tokens
  FOR EACH ROW
  EXECUTE FUNCTION qbo_tokens_set_updated_at();
