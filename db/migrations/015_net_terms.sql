-- 015_net_terms.sql
-- Net 30 / established-terms billing for approved clients. Two changes:
--
--   1. clients gains payment_terms_days + allow_invoice_checkout:
--        * payment_terms_days NULL  → pay-at-checkout (default for new
--          customers; everyone today).
--        * payment_terms_days 15/30/60/90 → on-account terms.
--        * allow_invoice_checkout TRUE → the public /shop/checkout flow
--          skips the card form for this client; the order is created
--          with payment_method='invoice_pending' and a QBO Invoice (not
--          Sales Receipt) goes out post-create. Staff approval gate;
--          DEFAULT FALSE so nobody gets credit by accident.
--
--   2. orders gains due_date — set only when payment_method =
--      'invoice_pending'. Drives the QBO Invoice DueDate and the
--      "payment due" copy in the customer-facing confirmation email.
--
-- Safe to re-run.

ALTER TABLE clients
  ADD COLUMN IF NOT EXISTS payment_terms_days INT
    CHECK (payment_terms_days IS NULL OR payment_terms_days IN (15, 30, 60, 90)),
  ADD COLUMN IF NOT EXISTS allow_invoice_checkout BOOLEAN NOT NULL DEFAULT FALSE;

ALTER TABLE orders
  ADD COLUMN IF NOT EXISTS due_date DATE;

-- Sanity: a client can't be approved for invoice-checkout without a
-- terms-days value (otherwise the orders endpoint would have nothing
-- to compute due_date from). Enforced via CHECK so the constraint
-- can't drift from the application logic.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'clients_invoice_checkout_requires_terms'
  ) THEN
    ALTER TABLE clients
      ADD CONSTRAINT clients_invoice_checkout_requires_terms
      CHECK (allow_invoice_checkout = FALSE OR payment_terms_days IS NOT NULL);
  END IF;
END $$;
