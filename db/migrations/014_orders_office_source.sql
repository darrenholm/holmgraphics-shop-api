-- 014_orders_office_source.sql
-- Office orders (placed by staff, not customer-driven through /shop/checkout):
--   1. Extend orders.source CHECK constraint to allow 'office'.
--   2. Add orders.payment_method column so the office endpoint can record
--      whether the customer paid by card / cash / e-transfer or is being
--      invoiced later. Online orders leave it NULL (always implicitly card).
--
-- The constraint name `orders_source_check` is what Postgres auto-assigns
-- to a CHECK on a single column at table-create time (per the convention
-- in migration 008 which seeded the table). Drop-and-recreate is the only
-- way to widen an enum-style CHECK -- ALTER ... ADD CONSTRAINT can't
-- replace an existing one in place.
--
-- Safe to re-run.

ALTER TABLE orders DROP CONSTRAINT IF EXISTS orders_source_check;
ALTER TABLE orders ADD CONSTRAINT orders_source_check
  CHECK (source IN ('online', 'quote_request', 'office'));

ALTER TABLE orders
  ADD COLUMN IF NOT EXISTS payment_method TEXT
    CHECK (payment_method IS NULL
        OR payment_method IN ('card', 'cash', 'etransfer', 'invoice_pending'));
