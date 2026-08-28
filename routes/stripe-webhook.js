// routes/stripe-webhook.js
// Stripe webhook receiver. Mounted at the app root as POST /webhooks/stripe.
//
// This is where a counter sale becomes money-of-record: the tablet drives the
// reader, but the `terminal_payments` row is completed and the QuickBooks
// write-back happens here. That split is the whole point — a tablet that
// loses WiFi between "approved" on the reader and "printed" on the receipt
// cannot lose the payment, because the sale never depended on the tablet
// telling us about it.
//
// Signature verification uses req.rawBody, stashed by the express.json()
// `verify` hook in server.js over the exact bytes Stripe signed. Do not
// switch this route to reading req.body — the parsed object re-serialises
// differently and every signature check fails.

'use strict';

const express = require('express');
const { query, queryOne } = require('../db/connection');
const { getStripe, stripeConfigured } = require('../lib/stripe-client');
const { writeBackPayment, writeBackRefund } = require('../lib/qbo-terminal-writeback');
const { completeIfFullyPaid } = require('../lib/job-completion');

const router = express.Router();

router.post('/webhooks/stripe', async (req, res) => {
  if (!stripeConfigured() || !process.env.STRIPE_WEBHOOK_SECRET) {
    console.error('[stripe-webhook] received an event but Stripe is not configured');
    return res.status(503).send('Stripe not configured');
  }

  const signature = req.headers['stripe-signature'];
  if (!signature) return res.status(400).send('Missing stripe-signature header');
  if (!req.rawBody) {
    // Only happens if the body parser stopped stashing raw bytes. Fail loudly
    // rather than silently accepting unverified events.
    console.error('[stripe-webhook] req.rawBody is missing — cannot verify the signature');
    return res.status(500).send('Raw body unavailable');
  }

  let event;
  try {
    event = getStripe().webhooks.constructEvent(
      req.rawBody, signature, process.env.STRIPE_WEBHOOK_SECRET
    );
  } catch (err) {
    console.error('[stripe-webhook] signature verification failed:', err.message);
    return res.status(400).send(`Webhook signature verification failed: ${err.message}`);
  }

  // ── Replay protection ──────────────────────────────────────────────────
  // Stripe retries until it gets a 2xx and can deliver the same event more
  // than once even after one. Every handler below writes to QuickBooks, so
  // claiming the event id first is not optional.
  const claimed = await queryOne(
    `INSERT INTO stripe_webhook_events (event_id, event_type)
     VALUES ($1, $2)
     ON CONFLICT (event_id) DO NOTHING
     RETURNING event_id`,
    [event.id, event.type]
  );
  if (!claimed) {
    return res.json({ received: true, duplicate: true });
  }

  // Acknowledge before doing the slow work. Stripe times a delivery out at
  // 20 seconds; a QBO write behind a 429 backoff can take longer than that,
  // and a timeout would put us straight back into a retry loop for work
  // that is already in flight. Failures are recorded on the row and
  // retryable from POST /api/terminal/payments/:id/resync.
  res.json({ received: true });

  try {
    await handleEvent(event);
    await query(
      `UPDATE stripe_webhook_events SET processed_at = NOW() WHERE event_id = $1`,
      [event.id]
    );
  } catch (err) {
    console.error(`[stripe-webhook] ${event.type} (${event.id}) failed:`, err.message);
    await query(
      `UPDATE stripe_webhook_events SET error = $1 WHERE event_id = $2`,
      [String(err.message).slice(0, 2000), event.id]
    );
  }
});

async function handleEvent(event) {
  switch (event.type) {
    case 'payment_intent.succeeded':      return onPaymentSucceeded(event.data.object);
    case 'payment_intent.payment_failed': return onPaymentFailed(event.data.object);
    case 'payment_intent.canceled':       return onPaymentCanceled(event.data.object);
    case 'charge.refunded':               return onChargeRefunded(event.data.object);
    default:
      // Not an error — the endpoint is deliberately subscribed to a narrow
      // set and Stripe will happily send more if someone widens it later.
      console.log(`[stripe-webhook] ignoring ${event.type}`);
      return null;
  }
}

// ─── payment_intent.succeeded ────────────────────────────────────────────────
async function onPaymentSucceeded(pi) {
  const row = await queryOne(
    `SELECT * FROM terminal_payments WHERE payment_intent_id = $1`,
    [pi.id]
  );
  if (!row) {
    // A PaymentIntent nobody here created. Online checkout will eventually
    // share this endpoint (spec §7); until then this is worth shouting about
    // rather than swallowing.
    console.warn(`[stripe-webhook] succeeded PaymentIntent ${pi.id} has no terminal_payments row`);
    return;
  }

  const details = await chargeDetails(pi);

  await query(
    `UPDATE terminal_payments
        SET status              = 'succeeded',
            charge_id           = COALESCE($1, charge_id),
            payment_method_type = COALESCE($2, payment_method_type),
            card_brand          = COALESCE($3, card_brand),
            card_last4          = COALESCE($4, card_last4),
            fee_cents           = COALESCE($5, fee_cents),
            net_cents           = COALESCE($6, net_cents),
            emv_receipt         = COALESCE($7, emv_receipt),
            decline_code        = NULL,
            failure_message     = NULL,
            updated_at          = NOW()
      WHERE id = $8`,
    [
      details.chargeId, details.methodType, details.brand, details.last4,
      details.feeCents, details.netCents,
      details.emvReceipt ? JSON.stringify(details.emvReceipt) : null,
      row.id,
    ]
  );

  // QBO is best-effort at this point: the money is recorded either way, and
  // a failure here is retryable without re-charging anyone.
  try {
    const result = await writeBackPayment(row.id);
    console.log(
      `[stripe-webhook] ${pi.id} → QBO ${result.docType || 'skipped'} ${result.docId || ''}`.trim()
    );
  } catch (err) {
    console.error(`[stripe-webhook] QBO write-back failed for ${pi.id}:`, err.message);
  }

  // Close the job off if this payment settled it. Independent of the QBO
  // write-back on purpose — a throttled QuickBooks shouldn't leave a paid job
  // sitting in Billing, and a job-status problem shouldn't look like an
  // accounting one. Only fires on full payment; see lib/job-completion.js.
  try {
    const done = await completeIfFullyPaid(row.project_id, { employeeId: row.taken_by_emp_id });
    console.log(
      `[stripe-webhook] ${pi.id} job #${row.project_id}: ` +
      (done.changed ? `status ${done.from} → Complete` : `left as-is (${done.reason})`)
    );
  } catch (err) {
    console.error(`[stripe-webhook] job completion check failed for ${pi.id}:`, err.message);
  }
}

// Pulls the charge with its balance transaction expanded, which is the only
// place the Stripe fee lives. Everything here is best-effort: a fee we can't
// read must not stop the sale from being recorded.
async function chargeDetails(pi) {
  const out = {
    chargeId: null, methodType: null, brand: null, last4: null,
    feeCents: null, netCents: null, emvReceipt: null,
  };
  const chargeId = typeof pi.latest_charge === 'string'
    ? pi.latest_charge
    : pi.latest_charge?.id || pi.charges?.data?.[0]?.id || null;
  if (!chargeId) return out;
  out.chargeId = chargeId;

  try {
    const charge = await getStripe().charges.retrieve(chargeId, {
      expand: ['balance_transaction'],
    });
    const bt = charge.balance_transaction;
    if (bt && typeof bt === 'object') {
      out.feeCents = bt.fee;
      out.netCents = bt.net;
    }
    const pmd = charge.payment_method_details || {};
    // Debit is `interac_present` for ALL Canadian debit, including
    // co-branded cards that would otherwise report brand "visa". Check it
    // first — this field is how you tell debit from credit when auditing
    // processing costs later.
    const present = pmd.interac_present || pmd.card_present || null;
    out.methodType = pmd.type || (pmd.interac_present ? 'interac_present' : null);
    if (present) {
      out.brand = present.brand || null;
      out.last4 = present.last4 || null;
      // The EMV block a card-present receipt is supposed to carry:
      // authorization_code, application_preferred_name, AID, and the
      // cardholder verification method that decides whether the sale needs
      // a signed merchant copy.
      out.emvReceipt = present.receipt || null;
    }
  } catch (err) {
    console.error(`[stripe-webhook] could not expand charge ${chargeId}:`, err.message);
  }
  return out;
}

// ─── payment_intent.payment_failed ───────────────────────────────────────────
// A decline is not an error state for the row: staff will collect against
// this same PaymentIntent again, which is Stripe's explicit guidance for
// Interac and what stops a customer being charged twice after a failed tap.
// The row therefore stays 'pending'; only the decline detail is recorded.
async function onPaymentFailed(pi) {
  const err = pi.last_payment_error || {};
  await query(
    `UPDATE terminal_payments
        SET decline_code    = $1,
            failure_message = $2,
            updated_at      = NOW()
      WHERE payment_intent_id = $3 AND status = 'pending'`,
    [err.decline_code || err.code || null, err.message || null, pi.id]
  );
  console.log(`[stripe-webhook] ${pi.id} declined: ${err.decline_code || err.code || 'unknown'}`);
}

async function onPaymentCanceled(pi) {
  await query(
    `UPDATE terminal_payments
        SET status = 'canceled', updated_at = NOW()
      WHERE payment_intent_id = $1 AND status = 'pending'`,
    [pi.id]
  );
}

// ─── charge.refunded ─────────────────────────────────────────────────────────
// Fires for credit-card refunds issued from the Stripe Dashboard or API.
// Interac refunds never arrive here: Interac requires the original card
// physically present at the reader and cannot be refunded through the API or
// the Dashboard at all. See TERMINAL_POS.md §Refunds.
async function onChargeRefunded(charge) {
  const piId = typeof charge.payment_intent === 'string'
    ? charge.payment_intent
    : charge.payment_intent?.id;
  if (!piId) return;

  const row = await queryOne(
    `SELECT * FROM terminal_payments WHERE payment_intent_id = $1`,
    [piId]
  );
  if (!row) {
    console.warn(`[stripe-webhook] refund on ${piId} has no terminal_payments row`);
    return;
  }

  // charge.amount_refunded is the running total, and the event fires again
  // for each partial refund. QBO needs the delta — posting the cumulative
  // figure a second time would refund the first amount twice.
  const refunded = charge.amount_refunded || 0;
  const delta    = refunded - (row.amount_refunded_cents || 0);
  const status   = refunded >= row.amount_cents ? 'refunded' : 'partially_refunded';

  await query(
    `UPDATE terminal_payments
        SET amount_refunded_cents = $1, status = $2, updated_at = NOW()
      WHERE id = $3`,
    [refunded, status, row.id]
  );

  try {
    await writeBackRefund(row.id, { refundedCents: delta });
  } catch (err) {
    console.error(`[stripe-webhook] QBO refund write-back failed for ${piId}:`, err.message);
  }
}

module.exports = router;
