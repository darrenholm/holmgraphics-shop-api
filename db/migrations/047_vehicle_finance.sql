-- 047_vehicle_finance.sql
-- Per-vehicle finance details — purchase / loan / lease. Sidecar
-- table (1:1 with vehicles) so the main vehicles table stays clean
-- and rows without finance info don't carry a swarm of NULL columns.
--
-- Holds:
--   • acquisition_type — owned / financed / leased
--   • lender / lessor name + contract number
--   • monetary basics (price, down payment, monthly, term, rate)
--   • start_date / end_date — the range that drives the calendar
--     reminders for "lease ends in 90 days"
--   • lease-specific: residual_value (buyout amount), mileage
--     allowance per year + excess-km charge
--
-- The expiry-summary endpoint will pick up lease end_date the same
-- way it surfaces ownership/insurance/inspection expiries today.

BEGIN;

CREATE TABLE IF NOT EXISTS vehicle_finance (
  id                       SERIAL PRIMARY KEY,
  vehicle_id               INT NOT NULL UNIQUE REFERENCES vehicles(id) ON DELETE CASCADE,
  acquisition_type         TEXT NOT NULL DEFAULT 'owned'
    CHECK (acquisition_type IN ('owned', 'financed', 'leased')),
  -- Common fields
  acquisition_date         DATE,
  lender                   TEXT,
  account_number           TEXT,
  -- Cost basics. NUMERIC(12,2) covers any vehicle the shop is likely
  -- to acquire (up to $99,999,999.99 — wildly excessive but the size
  -- on disk is negligible).
  purchase_price           NUMERIC(12, 2),
  down_payment             NUMERIC(12, 2),
  monthly_payment          NUMERIC(10, 2),
  term_months              INT,
  interest_rate            NUMERIC(6, 3),         -- e.g. 5.999 (%)
  start_date               DATE,
  end_date                 DATE,
  -- Lease-specific. NULL on owned/financed rows.
  residual_value           NUMERIC(12, 2),        -- buyout amount at end of lease
  mileage_allowance_km     INT,                   -- e.g. 24000 (per year)
  excess_mileage_charge    NUMERIC(6, 4),         -- per km, e.g. 0.18
  notes                    TEXT,
  created_at               TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at               TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  -- A leased vehicle must carry an end_date so reminders work.
  CONSTRAINT lease_has_end_date
    CHECK (acquisition_type != 'leased' OR end_date IS NOT NULL)
);

-- end_date drives the "upcoming lease expiries" dashboard query.
CREATE INDEX IF NOT EXISTS idx_vehicle_finance_end_date
  ON vehicle_finance(end_date)
  WHERE end_date IS NOT NULL;

-- Reuse the touch_updated_at helper from migration 035.
DROP TRIGGER IF EXISTS trg_vehicle_finance_touch ON vehicle_finance;
CREATE TRIGGER trg_vehicle_finance_touch BEFORE UPDATE ON vehicle_finance
  FOR EACH ROW EXECUTE FUNCTION touch_updated_at();

COMMIT;
