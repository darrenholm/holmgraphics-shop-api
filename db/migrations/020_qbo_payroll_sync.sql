-- 020_qbo_payroll_sync.sql
-- Tracks QBO payroll syncs: which time entries have been pushed to QBO
-- and their status. Helps prevent duplicate syncs and provides audit trail.

CREATE TABLE IF NOT EXISTS qbo_payroll_syncs (
  id              SERIAL PRIMARY KEY,
  pay_period_id   INTEGER NOT NULL REFERENCES pay_periods(id),
  synced_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  synced_by       INTEGER NOT NULL REFERENCES employees(id),
  entry_count     INTEGER NOT NULL,      -- how many entries were synced
  qbo_sync_token  TEXT,                  -- response token from QBO if available
  status          VARCHAR(20) DEFAULT 'pending',  -- pending, success, failed
  error_message   TEXT,                  -- if status='failed'
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Index for finding syncs by period
CREATE INDEX IF NOT EXISTS idx_qbo_payroll_syncs_pay_period
  ON qbo_payroll_syncs (pay_period_id);

-- Track which individual entries have been synced to QBO
ALTER TABLE time_entries ADD COLUMN IF NOT EXISTS qbo_synced_at TIMESTAMPTZ;
CREATE INDEX IF NOT EXISTS idx_time_entries_qbo_synced
  ON time_entries (qbo_synced_at);

-- Auto-bump updated_at
CREATE OR REPLACE FUNCTION qbo_payroll_syncs_set_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at := NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS qbo_payroll_syncs_updated_at_trigger ON qbo_payroll_syncs;
CREATE TRIGGER qbo_payroll_syncs_updated_at_trigger
  BEFORE UPDATE ON qbo_payroll_syncs
  FOR EACH ROW
  EXECUTE FUNCTION qbo_payroll_syncs_set_updated_at();
