-- 079_pickup_signature_details.sql
-- What the client signed for, kept with the signature.
--
-- The pickup slip now lists the items and quantities, the money (total,
-- paid, balance) and an optional staff note ("25 of 50 signs, rest Friday").
-- These are copied onto the row when the signature is requested, so a
-- reprint months later shows what was true at the counter — not whatever the
-- job's line items or invoice say by then.
--
-- 078 is taken on another branch (modules bin).
--
-- Safe to re-run.

ALTER TABLE pickup_signatures ADD COLUMN IF NOT EXISTS note          TEXT;
ALTER TABLE pickup_signatures ADD COLUMN IF NOT EXISTS items         JSONB;   -- [{ description, qty }]
ALTER TABLE pickup_signatures ADD COLUMN IF NOT EXISTS total_cents   INTEGER; -- tax in; NULL = job not priced
ALTER TABLE pickup_signatures ADD COLUMN IF NOT EXISTS paid_cents    INTEGER;
ALTER TABLE pickup_signatures ADD COLUMN IF NOT EXISTS balance_cents INTEGER;
ALTER TABLE pickup_signatures ADD COLUMN IF NOT EXISTS money_source  TEXT;    -- 'invoice' | 'job'
