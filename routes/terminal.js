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
  publishableKey, motoEnabled,
} = require('../lib/stripe-client');
const { sendPayLink } = require('../lib/customer-mailer');
const {
  writeBackPayment, writeBackOfflinePayment, qboPreflight, invoiceSummaryForProject,
} = require('../lib/qbo-terminal-writeback');

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
    // Phone / pay-link card entry runs Stripe.js in the browser.
    publishableKey: publishableKey(),
    moto:        motoEnabled(),
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

// ─── GET /api/terminal/job/:id/invoice ───────────────────────────────────────
// What's actually outstanding on this job's QuickBooks invoice right now.
//
// For the customer who walks in holding a printed invoice. The job's line
// items are the wrong number to charge from — they're ex-tax, and they don't
// know about part payments or anything edited in QuickBooks since the invoice
// was raised. This is the number on the paper in the customer's hand.
//
// Deliberately never fails the request: QuickBooks being down, disconnected or
// throttled must not stop anyone taking a payment. It answers `found: false`
// and the tablet falls back to the job total.
router.get('/job/:id/invoice', requireStaff, async (req, res) => {
  const projectId = Number.parseInt(req.params.id, 10);
  if (!Number.isInteger(projectId)) {
    return res.status(400).json({ error: 'job id must be an integer' });
  }
  res.json(await invoiceSummaryForProject(projectId));
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
          WHERE project_id = $1 AND status = 'pending' AND channel = 'counter'
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

// ─── POST /api/terminal/card-not-present ─────────────────────────────────────
// Body: { channel: 'phone'|'link', jobId, amountCents, subtotalCents?,
//         taxCents?, email? }
//
// A card payment that doesn't touch the reader. Either way it is a plain
// PaymentIntent recorded in terminal_payments first, so the existing
// payment_intent.succeeded webhook posts it to QuickBooks like any other
// Stripe sale.
//
//   phone → returns { id, clientSecret, publishableKey } for the card box on
//           the job page. Staff type the card; Stripe.js confirms it.
//   link  → returns { id, url, emailed } — a /pay/<token> page the customer
//           opens themselves. Making a new link for a job cancels its older
//           open ones, so a customer can't pay the same job twice from two
//           emails.
//
// email, when given, is where Stripe sends its card receipt (and, for a
// link, where the link is emailed).
const PAY_LINK_BASE = (process.env.PUBLIC_SHOP_URL || 'https://shop.holmgraphics.ca').replace(/\/$/, '');

router.post('/card-not-present', requireStaff, requireStripe, async (req, res) => {
  const { channel, jobId, description } = req.body || {};
  const amount = Number.parseInt(req.body?.amountCents, 10);
  const subtotalCents = Number.parseInt(req.body?.subtotalCents, 10);
  const taxCents = Number.parseInt(req.body?.taxCents, 10);
  const email = String(req.body?.email || '').trim().slice(0, 200) || null;

  if (channel !== 'phone' && channel !== 'link') {
    return res.status(400).json({ error: 'channel must be phone or link' });
  }
  if (!Number.isInteger(amount) || amount <= 0) {
    return res.status(400).json({ error: 'amountCents must be a positive integer number of cents' });
  }
  if (amount > MAX_AMOUNT_CENTS) {
    return res.status(400).json({ error: 'That amount looks like a typo.' });
  }
  if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return res.status(400).json({ error: 'That email address doesn\'t look right.' });
  }
  if (!publishableKey()) {
    return res.status(503).json({
      error: 'STRIPE_PUBLISHABLE_KEY is not set in Railway, so the card box can\'t load.',
    });
  }
  const projectId = jobId == null ? null : Number.parseInt(jobId, 10);

  try {
    const project = Number.isInteger(projectId)
      ? await queryOne(`SELECT id, client_id, description FROM projects WHERE id = $1`, [projectId])
      : null;
    if (projectId != null && !project) {
      return res.status(404).json({ error: `Job #${projectId} not found` });
    }

    // One live link per job. Cancel the old PaymentIntent too, so an old
    // email can't still take money.
    if (channel === 'link' && project) {
      const old = await query(
        `SELECT id, payment_intent_id FROM terminal_payments
          WHERE project_id = $1 AND channel = 'link' AND status = 'pending'`,
        [project.id]
      );
      for (const o of old) {
        try { await getStripe().paymentIntents.cancel(o.payment_intent_id); } catch { /* already done */ }
        await query(
          `UPDATE terminal_payments SET status = 'canceled', updated_at = NOW() WHERE id = $1`,
          [o.id]
        );
      }
    }

    const attemptId = crypto.randomBytes(8).toString('hex');
    const desc = (description || project?.description || 'Holm Graphics')
      .toString().slice(0, 200);
    const useMoto = channel === 'phone' && motoEnabled();

    const pi = await getStripe().paymentIntents.create({
      amount,
      currency: 'cad',
      payment_method_types: ['card'],
      ...(useMoto ? { payment_method_options: { card: { moto: true } } } : {}),
      description: desc,
      ...(email ? { receipt_email: email } : {}),
      metadata: {
        job_id:  projectId == null ? '' : String(projectId),
        source:  channel === 'phone' ? 'phone_keyed' : 'pay_link',
        emp_id:  String(req.user.id),
        attempt: attemptId,
      },
    }, {
      idempotencyKey: `cnp-${channel}-${projectId ?? 'none'}-${amount}-${attemptId}`,
    });

    const token = channel === 'link' ? crypto.randomBytes(24).toString('hex') : null;
    const row = await queryOne(
      `INSERT INTO terminal_payments
         (payment_intent_id, attempt_id, project_id, client_id, description,
          amount_cents, subtotal_cents, tax_cents, currency, status,
          taken_by_emp_id, channel, pay_token, receipt_email)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'cad', 'pending', $9, $10, $11, $12)
       RETURNING id`,
      [
        pi.id, attemptId, project?.id ?? null, project?.client_id ?? null, desc,
        amount,
        Number.isInteger(subtotalCents) ? subtotalCents : null,
        Number.isInteger(taxCents) ? taxCents : null,
        req.user.id, channel, token, email,
      ]
    );

    if (channel === 'phone') {
      return res.json({
        id: row.id,
        paymentIntentId: pi.id,
        clientSecret: pi.client_secret,
        publishableKey: publishableKey(),
        moto: useMoto,
      });
    }

    const url = `${PAY_LINK_BASE}/pay/${token}`;
    let emailed = null;
    if (email) {
      const r = await sendPayLink({
        email, url, amountCents: amount,
        projectId: project?.id ?? '', projectName: project?.description || '',
      });
      emailed = r.ok ? email : null;
      if (!r.ok) console.error('[terminal] pay link email failed:', r.error);
    }
    res.json({ id: row.id, url, emailed });
  } catch (err) {
    console.error('[terminal] card-not-present:', err.message);
    res.status(err.statusCode || 500).json({ error: err.message });
  }
});

// ─── POST /api/terminal/offline-payments ─────────────────────────────────────
// Body: { clientKey, method: 'cash'|'cheque', jobId, amountCents,
//         subtotalCents?, taxCents?, reference?, description? }
//
// Records a cash or cheque payment and posts it to QuickBooks (Undeposited
// Funds). The money is already in the drawer by the time this is called, so
// a QuickBooks failure is NOT an error response: the row is kept, the reply
// carries qbo_error, and the tablet offers Retry. clientKey makes a repeat
// of the same attempt return the original row instead of a second payment.
router.post('/offline-payments', requireStaff, async (req, res) => {
  try {
    const { clientKey, method, reference, description } = req.body || {};
    const amount = Number.parseInt(req.body?.amountCents, 10);
    const subtotalCents = Number.parseInt(req.body?.subtotalCents, 10);
    const taxCents = Number.parseInt(req.body?.taxCents, 10);
    const projectId = req.body?.jobId == null ? null : Number.parseInt(req.body.jobId, 10);

    if (!clientKey || typeof clientKey !== 'string' || clientKey.length > 100) {
      return res.status(400).json({ error: 'clientKey is required' });
    }
    if (method !== 'cash' && method !== 'cheque') {
      return res.status(400).json({ error: 'method must be cash or cheque' });
    }
    if (!Number.isInteger(amount) || amount <= 0) {
      return res.status(400).json({ error: 'amountCents must be a positive integer' });
    }
    const project = Number.isInteger(projectId)
      ? await queryOne(`SELECT id, client_id, description FROM projects WHERE id = $1`, [projectId])
      : null;
    if (projectId != null && !project) {
      return res.status(404).json({ error: `Job #${projectId} not found` });
    }

    const desc = (description || project?.description || 'Holm Graphics counter sale')
      .toString().slice(0, 200);
    const ref = method === 'cheque' && reference
      ? String(reference).trim().slice(0, 21) || null
      : null;

    await query(
      `INSERT INTO counter_offline_payments
         (client_key, method, project_id, client_id, description,
          amount_cents, subtotal_cents, tax_cents, reference, taken_by_emp_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
       ON CONFLICT (client_key) DO NOTHING`,
      [
        clientKey, method, project?.id ?? null, project?.client_id ?? null, desc,
        amount,
        Number.isInteger(subtotalCents) ? subtotalCents : null,
        Number.isInteger(taxCents) ? taxCents : null,
        ref, req.user.id,
      ]
    );
    const row = await queryOne(
      `SELECT * FROM counter_offline_payments WHERE client_key = $1`, [clientKey]
    );

    try {
      await writeBackOfflinePayment(row.id);
    } catch (err) {
      console.error(`[terminal] offline payment #${row.id} QBO:`, err.message);
    }
    res.json(await queryOne(`SELECT * FROM counter_offline_payments WHERE id = $1`, [row.id]));
  } catch (err) {
    console.error('[terminal] offline payment:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ─── POST /api/terminal/offline-payments/:id/resync ──────────────────────────
// Retry the QuickBooks post for a cash/cheque payment. A synced row is a no-op.
router.post('/offline-payments/:id/resync', requireStaff, async (req, res) => {
  const id = Number.parseInt(req.params.id, 10);
  try {
    await writeBackOfflinePayment(id);
  } catch (err) {
    console.error(`[terminal] offline resync #${id}:`, err.message);
  }
  const row = await queryOne(`SELECT * FROM counter_offline_payments WHERE id = $1`, [id]);
  if (!row) return res.status(404).json({ error: 'Not found' });
  res.json(row);
});

// ─── POST /api/terminal/payments/:id/refund ──────────────────────────────────
// Refunds a CREDIT card sale. Interac is deliberately refused here.
//
// Interac cannot be refunded through the Stripe API or the Dashboard at all —
// the network requires the original card back at the reader. That refund is
// driven natively on the tablet (HgPosPlugin.collectRefund/confirmRefund) and
// never touches this route; it lands back here as a charge.refunded webhook
// like any other refund, which is what posts the RefundReceipt to QuickBooks.
//
// So: this route exists so staff can refund a credit sale from the counter
// instead of logging into the Stripe Dashboard. Nothing here writes to
// QuickBooks — the webhook owns that, and giving it two writers would post
// the refund twice.
router.post('/payments/:id/refund', requireStaff, requireStripe, async (req, res) => {
  try {
    const row = await queryOne(
      `SELECT * FROM terminal_payments WHERE id = $1`,
      [Number.parseInt(req.params.id, 10)]
    );
    if (!row) return res.status(404).json({ error: 'Not found' });
    if (row.status !== 'succeeded' && row.status !== 'partially_refunded') {
      return res.status(409).json({ error: `Nothing to refund — this sale is ${row.status}.` });
    }
    if (!row.charge_id) {
      return res.status(409).json({
        error: 'Stripe has not finished settling this sale yet. Try again in a minute.',
      });
    }
    if (row.payment_method_type === 'interac_present') {
      return res.status(409).json({
        error: 'Interac refunds have to be done at the reader with the original card.',
        inPersonRequired: true,
      });
    }

    const remaining = row.amount_cents - (row.amount_refunded_cents || 0);
    const amount = req.body?.amountCents == null
      ? remaining
      : Number.parseInt(req.body.amountCents, 10);
    if (!Number.isInteger(amount) || amount <= 0) {
      return res.status(400).json({ error: 'amountCents must be a positive number of cents.' });
    }
    if (amount > remaining) {
      return res.status(400).json({
        error: `Only ${(remaining / 100).toFixed(2)} is left to refund on this sale.`,
      });
    }

    // Keyed on what has already been refunded, so a double-tap on Refund
    // replays the same request instead of refunding twice, while a genuine
    // second partial refund later gets its own key.
    const refund = await getStripe().refunds.create(
      {
        charge:   row.charge_id,
        amount,
        metadata: {
          hg_payment_id: String(row.id),
          hg_project_id: row.project_id == null ? '' : String(row.project_id),
          refunded_by:   String(req.user?.id || ''),
        },
      },
      { idempotencyKey: `hg-refund-${row.id}-${row.amount_refunded_cents || 0}-${amount}` }
    );

    res.json({
      ok: true,
      refundId:    refund.id,
      amountCents: refund.amount,
      status:      refund.status,
    });
  } catch (err) {
    console.error('[terminal] refund:', err.message);
    res.status(502).json({ error: err.message });
  }
});

// ─── Internet readers (WisePOS E) ────────────────────────────────────────────
// A different animal from the WisePad, and the reason this section exists.
//
// The WisePad is a Bluetooth reader: the tablet holds the connection, runs the
// Stripe SDK, and drives the sale. That connection is the thing that kept
// failing — the tablet's own Bluetooth service crashes, and nothing in the app
// can recover it (see reader_events and TERMINAL_POS.md).
//
// A WisePOS E talks to Stripe over WiFi instead. Nothing holds a connection to
// it, so there is nothing to drop. The server tells the reader which
// PaymentIntent to collect, the reader does the whole card interaction itself,
// and the outcome arrives on the webhook exactly as before. The till stops
// depending on one tablet's Bluetooth, and any browser in the shop can send a
// sale to the counter reader — which is what Darren asked for weeks ago and
// Bluetooth could never do.

// Everything the POS screen needs to show a reader and decide if it is usable.
function readerSummary(r) {
  return {
    id:          r.id,
    label:       r.label,
    deviceType:  r.device_type,
    serial:      r.serial_number,
    status:      r.status,                 // online | offline
    ipAddress:   r.ip_address,
    location:    r.location,
    // Present while a sale is in flight on the reader, and the only place the
    // outcome of a reader-driven collection shows up synchronously.
    action:      r.action ? {
      type:           r.action.type,
      status:         r.action.status,     // in_progress | succeeded | failed
      failureCode:    r.action.failure_code || null,
      failureMessage: r.action.failure_message || null,
      paymentIntent:  r.action.process_payment_intent?.payment_intent || null,
    } : null,
  };
}

router.get('/readers', requireStaff, requireStripe, async (req, res) => {
  try {
    const list = await getStripe().terminal.readers.list({ limit: 20 });
    res.json(list.data.map(readerSummary));
  } catch (err) {
    console.error('[terminal] list readers:', err.message);
    res.status(502).json({ error: err.message });
  }
});

router.get('/readers/:id', requireStaff, requireStripe, async (req, res) => {
  try {
    res.json(readerSummary(await getStripe().terminal.readers.retrieve(req.params.id)));
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

// Claims a new reader for the shop. The code comes off the reader's own screen
// (Settings → Generate pairing code) and is good for a few minutes.
router.post('/readers/register', requireStaff, requireStripe, async (req, res) => {
  const code = String(req.body?.registrationCode || '').trim();
  if (!code) return res.status(400).json({ error: 'registrationCode is required' });
  const location = terminalLocationId();
  if (!location) {
    return res.status(503).json({ error: 'STRIPE_TERMINAL_LOCATION_ID is not set on the server.' });
  }
  try {
    const reader = await getStripe().terminal.readers.create({
      registration_code: code,
      location,
      label: String(req.body?.label || 'Front counter').slice(0, 80),
    });
    res.json(readerSummary(reader));
  } catch (err) {
    console.error('[terminal] register reader:', err.message);
    res.status(400).json({ error: err.message });
  }
});

// ─── POST /api/terminal/readers/:id/collect ──────────────────────────────────
// Hands a sale to the reader. Returns as soon as the reader has accepted it —
// the customer has not tapped yet at that point, so the caller polls
// GET /readers/:id until the action stops being in_progress.
//
// No money moves here that the webhook does not already know about: this is
// the same PaymentIntent /payment-intent created and wrote to
// terminal_payments, so a browser that closes mid-sale loses nothing.
router.post('/readers/:id/collect', requireStaff, requireStripe, async (req, res) => {
  const paymentId = Number.parseInt(req.body?.paymentId, 10);
  if (!Number.isInteger(paymentId)) {
    return res.status(400).json({ error: 'paymentId (the terminal_payments row) is required' });
  }
  try {
    const row = await queryOne(`SELECT * FROM terminal_payments WHERE id = $1`, [paymentId]);
    if (!row) return res.status(404).json({ error: 'Payment not found' });
    if (row.status !== 'pending') {
      return res.status(409).json({ error: `That sale is already ${row.status}.` });
    }

    const reader = await getStripe().terminal.readers.processPaymentIntent(req.params.id, {
      payment_intent: row.payment_intent_id,
      // Lets the customer cancel on the reader's own screen rather than
      // leaving staff to notice and back out for them.
      process_config: { enable_customer_cancellation: true },
    });

    // Worth recording which reader took it: the fleet is mixed while the
    // WisePad is still in service, and "which one did this sale" is the first
    // question when something goes wrong.
    await query(
      `UPDATE terminal_payments SET reader_serial = $1, updated_at = NOW() WHERE id = $2`,
      [reader.serial_number || req.params.id, paymentId]
    );

    res.json(readerSummary(reader));
  } catch (err) {
    console.error('[terminal] reader collect:', err.message);
    res.status(502).json({ error: err.message });
  }
});

// Staff backed out, or the customer walked. Clears the reader's screen; the
// PaymentIntent itself is cancelled separately by /payment-intent/:id/cancel.
router.post('/readers/:id/cancel', requireStaff, requireStripe, async (req, res) => {
  try {
    res.json(readerSummary(await getStripe().terminal.readers.cancelAction(req.params.id)));
  } catch (err) {
    // A reader with nothing in flight rejects this, which is not worth
    // surfacing at a counter — the desired state is the actual state.
    if (/no active action|not currently/i.test(err.message || '')) return res.json({ ok: true });
    res.status(502).json({ error: err.message });
  }
});

// ─── Card-reader diary ───────────────────────────────────────────────────────
// The tablet writes down what the reader does so the next disconnect can be
// diagnosed from evidence instead of from whoever happens to be standing in
// front of it afterwards. See migration 069.
//
// Deliberately forgiving: this is diagnostics, and a logging endpoint that
// rejects a batch — or worse, throws on the tablet — would be worse than no
// logging at all. Unknown fields are dropped, a bad row is skipped rather
// than failing its batch, and the response never carries anything the tablet
// needs to act on.

// How many events one POST may carry. The tablet queues while offline and
// flushes on reconnect, so a batch is normal; a batch of thousands is a bug.
const MAX_EVENTS_PER_POST = 200;
// Diagnostics are worth keeping for a few weeks, not forever. Trimmed on
// write so nothing has to remember to run a cron.
const EVENT_RETENTION_DAYS = 30;

function cleanEvent(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const event = String(raw.event || '').trim().slice(0, 64);
  if (!event) return null;

  const battery = Number.parseInt(raw.batteryPct, 10);
  const when = raw.occurredAt ? new Date(raw.occurredAt) : new Date();

  return {
    event,
    reason:       raw.reason == null ? null : String(raw.reason).slice(0, 500),
    readerSerial: raw.readerSerial == null ? null : String(raw.readerSerial).slice(0, 64),
    batteryPct:   Number.isInteger(battery) && battery >= 0 && battery <= 100 ? battery : null,
    detail:       raw.detail && typeof raw.detail === 'object' ? raw.detail : null,
    // A tablet with a wrong clock must not bury every real event under a row
    // dated 2031, nor hide one behind a row dated 1970.
    occurredAt:   Number.isFinite(when.getTime()) ? when : new Date(),
  };
}

router.post('/reader-events', requireStaff, async (req, res) => {
  try {
    const incoming = Array.isArray(req.body?.events)
      ? req.body.events
      : [req.body].filter(Boolean);

    const rows = incoming.slice(0, MAX_EVENTS_PER_POST).map(cleanEvent).filter(Boolean);
    if (!rows.length) return res.json({ ok: true, stored: 0 });

    // One statement rather than a loop: the tablet flushes a backlog in a
    // single POST after a WiFi outage, and that must not become 200 queries.
    const values = [];
    const params = [];
    for (const r of rows) {
      const i = params.length;
      values.push(`($${i + 1}, $${i + 2}, $${i + 3}, $${i + 4}, $${i + 5}, $${i + 6})`);
      params.push(r.event, r.reason, r.readerSerial, r.batteryPct,
                  r.detail ? JSON.stringify(r.detail) : null, r.occurredAt);
    }
    await query(
      `INSERT INTO reader_events
         (event, reason, reader_serial, battery_pct, detail, occurred_at)
       VALUES ${values.join(', ')}`,
      params
    );

    await query(
      `DELETE FROM reader_events WHERE occurred_at < NOW() - INTERVAL '${EVENT_RETENTION_DAYS} days'`
    );

    res.json({ ok: true, stored: rows.length });
  } catch (err) {
    // Never make the tablet care. It has a customer at the counter and the
    // diary is the least important thing it is doing.
    console.error('[terminal] reader-events:', err.message);
    res.json({ ok: false });
  }
});

// The story, newest first. Read from the POS screen, and by whoever is
// working out why the reader dropped.
router.get('/reader-events', requireStaff, async (req, res) => {
  try {
    const limit = Math.min(Number.parseInt(req.query.limit, 10) || 100, 1000);
    const params = [];
    const where = ['1=1'];
    if (req.query.since) {
      params.push(new Date(req.query.since));
      where.push(`occurred_at >= $${params.length}`);
    }
    const rows = await query(
      `SELECT * FROM reader_events
        WHERE ${where.join(' AND ')}
        ORDER BY occurred_at DESC
        LIMIT ${limit}`,
      params
    );
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Stripe-side preflight ───────────────────────────────────────────────────
// An account can hold live keys, create PaymentIntents and even take a card
// while still being unable to pay the money out. That failure surfaces days
// later as money that never arrived, so it is worth asserting rather than
// assuming — charges_enabled and payouts_enabled are separate flags and only
// the first is proved by a successful sale.
async function stripeChecks() {
  const checks = [];
  const add = (name, ok, detail) => checks.push({ name, ok, detail });

  let acct;
  try {
    acct = await getStripe().accounts.retrieve();
  } catch (err) {
    add('Stripe account', false, err.message);
    return checks;
  }

  add('Stripe account', true,
    `${acct.business_profile?.name || acct.id} — ${(acct.country || '??')}, ` +
    `${(acct.default_currency || '').toUpperCase()}`);

  add('Charges enabled', !!acct.charges_enabled,
    acct.charges_enabled
      ? 'the account can take payments'
      : `BLOCKED — ${acct.requirements?.disabled_reason || 'verification incomplete'}`);

  // The one that bites quietly: cards approve, money never lands.
  add('Payouts enabled', !!acct.payouts_enabled,
    acct.payouts_enabled
      ? 'money will reach the bank'
      : 'BLOCKED — payments will succeed but nothing will be paid out');

  const due = [
    ...(acct.requirements?.past_due || []),
    ...(acct.requirements?.currently_due || []),
  ];
  add('Outstanding requirements', due.length === 0,
    due.length ? due.join(', ') : 'none — verification complete');

  // A Location created in the other mode silently fails discovery, so check
  // the one we are actually configured with resolves under this key.
  const locId = terminalLocationId();
  if (!locId) {
    add('Terminal Location', false, 'STRIPE_TERMINAL_LOCATION_ID is not set');
  } else {
    try {
      const loc = await getStripe().terminal.locations.retrieve(locId);
      add('Terminal Location', true,
        `${loc.display_name} (${loc.address?.city || '?'}, ${loc.address?.country || '?'}) — ` +
        `${isTestMode() ? 'test' : 'live'} mode`);
    } catch (err) {
      add('Terminal Location', false,
        `${locId} did not resolve: ${err.message}. A Location created in the other ` +
        `mode will not work with this key.`);
    }
  }

  return checks;
}

// ─── GET /api/terminal/preflight ─────────────────────────────────────────────
// Run this before the first live sale. Every check that fails here would
// otherwise fail as a webhook, with a customer already charged — or worse, as
// a payout that never arrives.
router.get('/preflight', requireStaff, async (req, res) => {
  try {
    const qbo = await qboPreflight();
    const stripe = stripeConfigured()
      ? await stripeChecks()
      : [{ name: 'Stripe', ok: false, detail: 'STRIPE_SECRET_KEY is not set' }];
    const checks = [...stripe, ...qbo.checks];
    res.json({ ok: checks.every((c) => c.ok), checks });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// Kept so an older tablet build keeps working after a deploy.
router.get('/qbo-preflight', requireStaff, async (req, res) => {
  try {
    res.json(await qboPreflight());
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

module.exports = router;
