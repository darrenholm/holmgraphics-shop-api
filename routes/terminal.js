// routes/terminal.js
// Counter POS — Stripe Terminal endpoints. Mounted at /api/terminal.
//
// The tablet never holds a Stripe secret key and never writes to QuickBooks.
// It asks for a connection token, asks for a PaymentIntent, and drives the
// reader. Everything that decides where money ends up happens server-side,
// off the webhook (routes/stripe-webhook.js → lib/qbo-terminal-writeback.js),
// so a tablet that drops WiFi mid-transaction cannot lose a payment record.
//
// EVERY route here requires staff auth. A connection token is the ability to
// take payments on the Stripe account; the capgo plugin's built-in
// `tokenProviderEndpoint` would fetch it with an unauthenticated POST, which
// is why the app fetches tokens itself and hands them to the SDK via
// setConnectionToken(). See src/lib/pos/terminal.js in the shop repo.

'use strict';

const express = require('express');
const crypto  = require('crypto');
const { query, queryOne } = require('../db/connection');
const { requireStaff } = require('../middleware/auth');
const {
  getStripe, stripeConfigured, isTestMode, terminalLocationId,
} = require('../lib/stripe-client');
const { writeBackPayment, qboPreflight } = require('../lib/qbo-terminal-writeback');

const router = express.Router();

// Interac Flash caps out at $250 and the reader forces insert+PIN over $100,
// but neither is a ceiling we impose. This is a fat-finger guard: a counter
// sale over $25k is a typo, and the customer is standing right there.
const MAX_AMOUNT_CENTS = 2_500_000;

function requireStripe(req, res, next) {
  if (!stripeConfigured()) {
    return res.status(503).json({
      error: 'Stripe is not configured on this server. Set STRIPE_SECRET_KEY in Railway.',
    });
  }
  next();
}

// ─── GET /api/terminal/config ────────────────────────────────────────────────
// The tablet reads this at startup. isTest comes from the shape of the key
// the server actually holds rather than a second flag that can drift out of
// sync — a mismatch there surfaces as an opaque "no readers found".
router.get('/config', requireStaff, (req, res) => {
  res.json({
    configured:  stripeConfigured(),
    isTest:      isTestMode(),
    locationId:  terminalLocationId(),
    // Nothing to connect to without a Location; say so plainly rather than
    // letting discovery come back empty.
    ready:       stripeConfigured() && !!terminalLocationId(),
  });
});

// ─── POST /api/terminal/connection-token ─────────────────────────────────────
// The SDK calls back here whenever it needs a token; it manages the
// lifecycle, so nothing is cached or persisted on either side.
router.post('/connection-token', requireStaff, requireStripe, async (req, res) => {
  try {
    const token = await getStripe().terminal.connectionTokens.create(
      terminalLocationId() ? { location: terminalLocationId() } : {}
    );
    res.json({ secret: token.secret });
  } catch (err) {
    console.error('[terminal] connection-token:', err.message);
    res.status(502).json({ error: `Stripe refused the connection token: ${err.message}` });
  }
});

// ─── POST /api/terminal/payment-intent ───────────────────────────────────────
// Body: { jobId, amountCents, description?, subtotalCents?, taxCents?,
//         readerSerial?, captureMethod? }
//
// Returns { paymentIntentId, clientSecret, amountCents, reused }.
//
// collectPaymentMethod() on the Android SDK takes the CLIENT SECRET, not the
// id — it calls Terminal.retrievePaymentIntent(clientSecret) under the hood.
// Both are returned so the caller can't get that wrong.
router.post('/payment-intent', requireStaff, requireStripe, async (req, res) => {
  const {
    jobId, amountCents, description,
    subtotalCents, taxCents, readerSerial,
    captureMethod,
  } = req.body || {};

  const amount = Number.parseInt(amountCents, 10);
  if (!Number.isInteger(amount) || amount <= 0) {
    return res.status(400).json({ error: 'amountCents must be a positive integer number of cents' });
  }
  if (amount > MAX_AMOUNT_CENTS) {
    return res.status(400).json({
      error: `amountCents of ${amount} looks like a typo (limit $${(MAX_AMOUNT_CENTS / 100).toLocaleString()}).`,
    });
  }
  const projectId = jobId == null ? null : Number.parseInt(jobId, 10);
  if (jobId != null && !Number.isInteger(projectId)) {
    return res.status(400).json({ error: 'jobId must be an integer project id' });
  }

  // Interac cannot be authorised and captured separately — it accepts only
  // 'automatic', 'automatic_async' or 'manual_preferred'. Plain 'manual'
  // declines EVERY Interac transaction, so it is not reachable from here.
  const capture = captureMethod === 'manual_preferred' ? 'manual_preferred' : 'automatic';

  try {
    const project = projectId
      ? await queryOne(
          `SELECT id, client_id, description FROM projects WHERE id = $1`,
          [projectId]
        )
      : null;
    if (projectId && !project) {
      return res.status(404).json({ error: `Job #${projectId} not found` });
    }

    // ── Reuse an in-flight attempt ────────────────────────────────────────
    // Stripe's explicit guidance for Interac: after a decline, collect
    // against the SAME PaymentIntent. Minting a fresh one per retry is how
    // you double-charge a customer whose first tap failed.
    if (projectId) {
      const open = await queryOne(
        `SELECT * FROM terminal_payments
          WHERE project_id = $1 AND status = 'pending'
          LIMIT 1`,
        [projectId]
      );
      if (open) {
        const reusable = await reuseOrRelease(open, amount);
        if (reusable) {
          return res.json({
            // `id` is the terminal_payments row — the tablet polls it for the
            // fee and EMV block after approval. It is NOT the PaymentIntent
            // id, and mixing the two here would break the receipt on exactly
            // the retry path this branch exists to serve.
            id:              open.id,
            paymentIntentId: reusable.id,
            clientSecret:    reusable.client_secret,
            amountCents:     reusable.amount,
            reused:          true,
          });
        }
      }
    }

    // ── Create ────────────────────────────────────────────────────────────
    // attemptId distinguishes one attempt at a given (job, amount) from the
    // next, so a double-tap on "Take Payment" collapses to one PaymentIntent
    // while a genuine second sale for the same amount does not.
    const attemptId = crypto.randomBytes(8).toString('hex');
    const desc = (description || project?.description || 'Holm Graphics counter sale')
      .toString().slice(0, 200);

    const pi = await getStripe().paymentIntents.create({
      amount,
      currency: 'cad',
      payment_method_types: ['card_present', 'interac_present'],
      capture_method: capture,
      description: desc,
      metadata: {
        job_id:  projectId == null ? '' : String(projectId),
        source:  'counter_pos',
        emp_id:  String(req.user.id),
        attempt: attemptId,
      },
    }, {
      idempotencyKey: `job-${projectId ?? 'none'}-${amount}-${attemptId}`,
    });

    // Persisted BEFORE the client_secret goes out the door: from this point
    // on there is no charge Stripe knows about that we don't.
    const row = await queryOne(
      `INSERT INTO terminal_payments
         (payment_intent_id, attempt_id, project_id, client_id, description,
          amount_cents, subtotal_cents, tax_cents, currency, status,
          taken_by_emp_id, reader_serial)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'cad', 'pending', $9, $10)
       RETURNING id`,
      [
        pi.id, attemptId, projectId, project?.client_id ?? null, desc,
        amount,
        Number.isInteger(subtotalCents) ? subtotalCents : null,
        Number.isInteger(taxCents) ? taxCents : null,
        req.user.id, readerSerial || null,
      ]
    );

    res.json({
      id:              row.id,
      paymentIntentId: pi.id,
      clientSecret:    pi.client_secret,
      amountCents:     amount,
      captureMethod:   capture,
      reused:          false,
    });
  } catch (err) {
    // reuseOrRelease raises a 409 when a payment for this job is already
    // settling — that's a conflict to show the counter, not a gateway error.
    if (err.status === 409) return res.status(409).json({ error: err.message });
    console.error('[terminal] payment-intent:', err.message);
    res.status(502).json({ error: err.message });
  }
});

// Decides what to do with an existing pending row. Returns the live
// PaymentIntent when it can still be collected against at this amount,
// otherwise releases the row (cancelling the PI at Stripe) and returns null
// so the caller creates a fresh one.
//
// A pending row whose PaymentIntent already succeeded means the webhook
// hasn't landed yet — never hand that back out to be collected again.
async function reuseOrRelease(row, amount) {
  let pi = null;
  try {
    pi = await getStripe().paymentIntents.retrieve(row.payment_intent_id);
  } catch {
    // Gone from Stripe entirely (test-mode wipe, wrong key). Drop the row.
    await query(
      `UPDATE terminal_payments SET status = 'canceled', updated_at = NOW() WHERE id = $1`,
      [row.id]
    );
    return null;
  }

  const collectable = ['requires_payment_method', 'requires_confirmation', 'requires_capture'];
  if (pi.amount === amount && collectable.includes(pi.status)) return pi;

  if (pi.status === 'succeeded' || pi.status === 'processing') {
    // Let the webhook finish. Surfacing this as a conflict is much safer
    // than issuing a second PaymentIntent for a sale that already went
    // through and is only a few seconds from being recorded.
    const err = new Error(
      `Job #${row.project_id} already has a payment settling (${row.payment_intent_id}). ` +
      `Wait a few seconds and refresh before taking another.`
    );
    err.status = 409;
    throw err;
  }

  // Different amount, or a dead intent — cancel it so the partial unique
  // index frees up, then let the caller create the new one.
  if (collectable.includes(pi.status)) {
    try { await getStripe().paymentIntents.cancel(pi.id); } catch { /* already gone */ }
  }
  await query(
    `UPDATE terminal_payments SET status = 'canceled', updated_at = NOW() WHERE id = $1`,
    [row.id]
  );
  return null;
}

// ─── POST /api/terminal/payment-intent/:piId/cancel ──────────────────────────
// Staff backed out before the customer presented a card.
router.post('/payment-intent/:piId/cancel', requireStaff, requireStripe, async (req, res) => {
  try {
    const row = await queryOne(
      `SELECT * FROM terminal_payments WHERE payment_intent_id = $1`,
      [req.params.piId]
    );
    if (!row) return res.status(404).json({ error: 'Unknown PaymentIntent' });
    if (row.status !== 'pending') {
      return res.status(409).json({ error: `Cannot cancel a payment that is already "${row.status}"` });
    }
    try {
      await getStripe().paymentIntents.cancel(row.payment_intent_id);
    } catch (err) {
      // A PI that already succeeded can't be cancelled — and mustn't be
      // marked cancelled locally either.
      if (err?.code === 'payment_intent_unexpected_state') {
        return res.status(409).json({ error: 'That payment has already gone through.' });
      }
      throw err;
    }
    await query(
      `UPDATE terminal_payments SET status = 'canceled', updated_at = NOW() WHERE id = $1`,
      [row.id]
    );
    res.json({ ok: true });
  } catch (err) {
    console.error('[terminal] cancel:', err.message);
    res.status(502).json({ error: err.message });
  }
});

// ─── GET /api/terminal/payments ──────────────────────────────────────────────
// ?jobId= | ?status= | ?unsynced=1 | ?limit=
// Backs both the job-detail payment history and the admin reconciliation view.
router.get('/payments', requireStaff, async (req, res) => {
  try {
    const where = ['1=1'];
    const params = [];
    if (req.query.jobId) {
      params.push(Number.parseInt(req.query.jobId, 10));
      where.push(`tp.project_id = $${params.length}`);
    }
    if (req.query.status) {
      params.push(String(req.query.status));
      where.push(`tp.status = $${params.length}`);
    }
    if (req.query.unsynced === '1') {
      where.push(`tp.qbo_synced_at IS NULL AND tp.status IN ('succeeded','refunded','partially_refunded')`);
    }
    const limit = Math.min(Number.parseInt(req.query.limit, 10) || 50, 500);

    const rows = await query(
      `SELECT tp.*,
              COALESCE(c.company, CONCAT_WS(' ', c.fname, c.lname)) AS client_name,
              CONCAT_WS(' ', e.first_name, e.last_name)             AS taken_by
         FROM terminal_payments tp
         LEFT JOIN clients   c ON c.id = tp.client_id
         LEFT JOIN employees e ON e.id = tp.taken_by_emp_id
        WHERE ${where.join(' AND ')}
        ORDER BY tp.created_at DESC
        LIMIT ${limit}`,
      params
    );
    res.json(rows);
  } catch (err) {
    console.error('[terminal] list payments:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ─── GET /api/terminal/payments/:id ──────────────────────────────────────────
// Everything the receipt printer needs, in one call.
router.get('/payments/:id', requireStaff, async (req, res) => {
  try {
    const row = await queryOne(
      `SELECT tp.*,
              COALESCE(c.company, CONCAT_WS(' ', c.fname, c.lname)) AS client_name,
              CONCAT_WS(' ', e.first_name, e.last_name)             AS taken_by
         FROM terminal_payments tp
         LEFT JOIN clients   c ON c.id = tp.client_id
         LEFT JOIN employees e ON e.id = tp.taken_by_emp_id
        WHERE tp.id = $1`,
      [Number.parseInt(req.params.id, 10)]
    );
    if (!row) return res.status(404).json({ error: 'Not found' });
    res.json(row);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── POST /api/terminal/payments/:id/resync ──────────────────────────────────
// Retry the QuickBooks write-back after a 429 storm, a token expiry, or a
// missing clearing account. Idempotent — a row that already synced is a
// no-op, not a duplicate posting.
router.post('/payments/:id/resync', requireStaff, async (req, res) => {
  try {
    const result = await writeBackPayment(Number.parseInt(req.params.id, 10));
    res.json({ ok: true, ...result });
  } catch (err) {
    console.error('[terminal] resync:', err.message);
    res.status(502).json({ error: err.message, setupRequired: !!err.setupRequired });
  }
});

// ─── GET /api/terminal/qbo-preflight ─────────────────────────────────────────
// Run this before the first live sale. Every check that fails here would
// otherwise fail as a webhook, with a customer already charged.
router.get('/qbo-preflight', requireStaff, async (req, res) => {
  try {
    res.json(await qboPreflight());
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

module.exports = router;
