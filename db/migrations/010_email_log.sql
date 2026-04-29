-- 010_email_log.sql
-- Two changes for the online-order finishing-touches branch:
--   1. orders.notification_email — per-order contact email captured at
--      checkout. Falls back to clients.email at send time if NULL. Lets a
--      customer route a one-off order to a different inbox without
--      changing their account email (which is also their login).
--   2. email_log — idempotency log for transactional emails fired off
--      order status changes (see lib/customer-mailer.js sendForOrderStatus).
-- Safe to re-run.

-- ─── 1. orders.notification_email ────────────────────────────────────────────

ALTER TABLE orders
  ADD COLUMN IF NOT EXISTS notification_email TEXT;

-- ─── 2. email_log ────────────────────────────────────────────────────────────
-- Idempotency log for transactional emails fired off order status changes.
-- One row per (order_id, kind) — the UNIQUE constraint is the durable
-- "have we already sent this?" check. Race-safe: the second concurrent
-- INSERT loses to the first and the helper skips the duplicate send.
--
-- kind values mirror lib/customer-mailer.js's `kind` parameter so a row
-- here corresponds 1:1 with a Resend send attempt.
--
-- sent_at is when the helper recorded the result (success OR failure).
-- ok=true means Resend accepted (or the helper ran in stub mode without
-- RESEND_API_KEY); ok=false captures retryable failures so an admin can
-- re-trigger by deleting the failure row.
--
-- Safe to re-run.

CREATE TABLE IF NOT EXISTS email_log (
  id          SERIAL PRIMARY KEY,
  order_id    INT NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  kind        TEXT NOT NULL,           -- e.g. 'order-confirmation', 'proof-request', 'order-ready-for-pickup'
  ok          BOOLEAN NOT NULL,
  message_id  TEXT,                    -- Resend's id, when ok=true
  error       TEXT,                    -- failure detail, when ok=false
  sent_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Idempotency guard. Successful sends (ok=true) of a given kind for a given
-- order are unique. Failures (ok=false) are NOT in the unique set so an
-- admin can retry by re-running the helper after clearing the bad row.
CREATE UNIQUE INDEX IF NOT EXISTS email_log_order_kind_ok_idx
  ON email_log (order_id, kind)
  WHERE ok = TRUE;

CREATE INDEX IF NOT EXISTS email_log_order_idx
  ON email_log (order_id, sent_at DESC);
