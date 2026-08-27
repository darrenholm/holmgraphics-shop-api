-- 059_terminal_payments.sql
-- Counter POS (Stripe Terminal / BBPOS WisePad 3) payment ledger.
--
-- One row per PaymentIntent created for a front-counter sale. The row is
-- written BEFORE the tablet is handed the client_secret, so a tablet that
-- loses WiFi mid-transaction can never leave a charge with no local record —
-- the webhook fills in the rest.
--
-- Deliberately a separate table from the DTF store's `payments`
-- (008_dtf_store_schema.sql): that one is per online order and keyed to
-- QB Payments charge ids. Counter sales are per *project* (job), settle
-- through Stripe, and carry Terminal-only fields (reader serial, Interac
-- vs card_present, the Stripe fee). Sharing one table would mean half the
-- columns NULL on every row of either kind.
--
-- Money is stored in CENTS (integers) end to end, because that's what both
-- the Stripe API and the Terminal SDK speak. Convert to dollars only at the
-- QBO boundary and on the printed receipt.
--
-- Safe to re-run.

CREATE TABLE IF NOT EXISTS terminal_payments (
  id                     SERIAL      PRIMARY KEY,

  -- ─── Stripe identifiers ───────────────────────────────────────────────
  payment_intent_id      TEXT        NOT NULL UNIQUE,
  charge_id              TEXT,                    -- set by the webhook
  -- Distinguishes one attempt at a given (project, amount) from the next.
  -- Feeds the Stripe idempotency key so a double-tap on "Take Payment"
  -- reuses the same PaymentIntent instead of minting a second one.
  attempt_id             TEXT        NOT NULL,

  -- ─── What was sold ────────────────────────────────────────────────────
  project_id             INT         REFERENCES projects(id) ON DELETE SET NULL,
  client_id              INT         REFERENCES clients(id)  ON DELETE SET NULL,
  description            TEXT,
  amount_cents           INT         NOT NULL CHECK (amount_cents > 0),
  -- Tax split as the tablet computed it. Only used on the no-invoice
  -- (SalesReceipt) write-back path; the Payment-against-Invoice path takes
  -- the invoice's own tax and ignores these.
  subtotal_cents         INT,
  tax_cents              INT,
  currency               TEXT        NOT NULL DEFAULT 'cad',

  -- ─── Outcome ──────────────────────────────────────────────────────────
  status                 TEXT        NOT NULL DEFAULT 'pending'
                                     CHECK (status IN ('pending', 'succeeded', 'failed',
                                                       'canceled', 'refunded',
                                                       'partially_refunded')),
  -- 'interac_present' for ALL debit, including co-branded cards. This is
  -- how you tell debit from credit when auditing processing cost later —
  -- card_brand alone will say "Visa" on a Visa Debit tapped as Interac.
  payment_method_type    TEXT,
  card_brand             TEXT,
  card_last4             TEXT,
  fee_cents              INT,                     -- Stripe's fee, from the balance transaction
  net_cents              INT,
  decline_code           TEXT,
  failure_message        TEXT,
  amount_refunded_cents  INT         NOT NULL DEFAULT 0,
  -- charge.payment_method_details.{card_present|interac_present}.receipt —
  -- the EMV block (authorization_code, application_preferred_name, AID,
  -- cardholder_verification_method …) that a card-present receipt is
  -- supposed to carry. It arrives a second or two after the reader approves,
  -- so the tablet prints without it if the webhook is slow; storing it means
  -- a reprint is always complete.
  emv_receipt            JSONB,

  -- ─── Provenance ───────────────────────────────────────────────────────
  taken_by_emp_id        INT         REFERENCES employees(id) ON DELETE SET NULL,
  reader_serial          TEXT,

  -- ─── QuickBooks write-back ────────────────────────────────────────────
  -- qbo_doc_type is 'Payment' when the job already had an Invoice in QBO
  -- (the payment is applied against it), 'SalesReceipt' when it didn't.
  qbo_doc_type           TEXT        CHECK (qbo_doc_type IN ('Payment', 'SalesReceipt')),
  qbo_doc_id             TEXT,
  qbo_fee_purchase_id    TEXT,                    -- the Stripe-fee expense
  qbo_refund_id          TEXT,                    -- RefundReceipt / Credit Memo
  qbo_synced_at          TIMESTAMPTZ,
  qbo_attempts           INT         NOT NULL DEFAULT 0,
  qbo_error              TEXT,
  -- Set when QBO's recalculated document total doesn't match what we
  -- actually charged (a rounding edge on the SalesReceipt path). Surfaced
  -- in the admin UI rather than silently leaving the clearing account off
  -- by a cent.
  qbo_warning            TEXT,

  created_at             TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at             TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_terminal_payments_project
  ON terminal_payments (project_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_terminal_payments_status
  ON terminal_payments (status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_terminal_payments_charge
  ON terminal_payments (charge_id);
-- Partial index over the QBO retry queue: succeeded but not yet written back.
CREATE INDEX IF NOT EXISTS idx_terminal_payments_qbo_pending
  ON terminal_payments (created_at)
  WHERE status IN ('succeeded', 'refunded', 'partially_refunded')
    AND qbo_synced_at IS NULL;

-- Reusing an in-flight PaymentIntent after a decline is Stripe's explicit
-- guidance for Interac (a fresh PI per retry is how you double-charge a
-- customer whose first tap failed). This partial unique index makes the
-- "one open attempt per job" rule structural rather than a convention.
CREATE UNIQUE INDEX IF NOT EXISTS idx_terminal_payments_open_per_project
  ON terminal_payments (project_id)
  WHERE status = 'pending' AND project_id IS NOT NULL;


-- ─── Stripe webhook de-duplication ───────────────────────────────────────────
-- Stripe retries a webhook until it gets a 2xx, and can deliver the same
-- event more than once even after a 2xx. Every handler here writes to QBO,
-- so replay protection is not optional. The handler claims an event by
-- INSERTing its id; a conflict means someone already has it.
CREATE TABLE IF NOT EXISTS stripe_webhook_events (
  event_id     TEXT        PRIMARY KEY,
  event_type   TEXT        NOT NULL,
  received_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  processed_at TIMESTAMPTZ,
  error        TEXT
);

CREATE INDEX IF NOT EXISTS idx_stripe_webhook_events_unprocessed
  ON stripe_webhook_events (received_at)
  WHERE processed_at IS NULL;
