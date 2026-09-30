-- 073_counter_offline_payments.sql
-- Cash and cheque taken at the counter.
--
-- Until now the Take Payment screen only printed a receipt for these and
-- left QuickBooks to be keyed by hand — which in practice meant the invoice
-- stayed open. Now each one is recorded here and posted to QBO as a Payment
-- against the job's invoice (or a SalesReceipt when there is none),
-- deposited to Undeposited Funds so it lands on the next Bank Deposit with
-- the rest of the day's cheques.
--
-- Deliberately a separate table from terminal_payments: that table is the
-- Stripe ledger and reconciles against Stripe payouts. Cash never goes near
-- Stripe.
--
-- Safe to re-run.

CREATE TABLE IF NOT EXISTS counter_offline_payments (
  id              BIGSERIAL   PRIMARY KEY,

  -- Minted by the tablet per attempt, so a double-tap or a retry after a
  -- dropped connection records the payment once, not twice.
  client_key      TEXT        NOT NULL UNIQUE,

  method          TEXT        NOT NULL CHECK (method IN ('cash', 'cheque')),
  project_id      INT,
  client_id       INT,
  description     TEXT,

  amount_cents    INT         NOT NULL CHECK (amount_cents > 0),
  subtotal_cents  INT,
  tax_cents       INT,

  -- Cheque number, if staff typed one. Goes on the QBO payment as Ref no.
  reference       TEXT,

  taken_by_emp_id INT,

  qbo_doc_type    TEXT,           -- 'Payment' | 'SalesReceipt'
  qbo_doc_id      TEXT,
  qbo_warning     TEXT,
  qbo_error       TEXT,
  qbo_attempts    INT         NOT NULL DEFAULT 0,
  qbo_synced_at   TIMESTAMPTZ,

  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS counter_offline_payments_project_idx
  ON counter_offline_payments (project_id, created_at DESC);
