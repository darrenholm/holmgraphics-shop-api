-- 074_card_not_present.sql
-- Card payments over the phone.
--
-- Two ways in, both ordinary Stripe PaymentIntents, so they settle, pay out
-- and post to QuickBooks exactly like a WisePad sale (the payment_intent
-- webhook → writeBackPayment → Stripe clearing account):
--
--   phone — staff type the card into a Stripe card box on the job page
--   link  — the customer gets a /pay/<token> link and types it in themselves
--
-- They live in terminal_payments because that table IS the Stripe ledger;
-- `channel` says which way the card came in.
--
-- Safe to re-run.

ALTER TABLE terminal_payments
  ADD COLUMN IF NOT EXISTS channel TEXT NOT NULL DEFAULT 'counter';

DO $$ BEGIN
  ALTER TABLE terminal_payments
    ADD CONSTRAINT terminal_payments_channel_check
    CHECK (channel IN ('counter', 'phone', 'link'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- The customer-facing link's secret. Random, unguessable; the link is the
-- only auth the pay page has.
ALTER TABLE terminal_payments
  ADD COLUMN IF NOT EXISTS pay_token TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS terminal_payments_pay_token_idx
  ON terminal_payments (pay_token) WHERE pay_token IS NOT NULL;

ALTER TABLE terminal_payments
  ADD COLUMN IF NOT EXISTS receipt_email TEXT;

-- "One open attempt per job" exists so a declined tap at the reader is
-- retried on the SAME PaymentIntent. It must not count a pay link that sits
-- open for days, or a phone payment, or the counter could never take a card
-- for that job while a link was out.
DROP INDEX IF EXISTS idx_terminal_payments_open_per_project;
CREATE UNIQUE INDEX IF NOT EXISTS idx_terminal_payments_open_per_project
  ON terminal_payments (project_id)
  WHERE status = 'pending' AND project_id IS NOT NULL AND channel = 'counter';
