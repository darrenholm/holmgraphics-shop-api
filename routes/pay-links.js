// routes/pay-links.js
//
// Public side of a card payment link (Take Payment → Pay link). No login:
// the 48-hex-char token in the URL is the only auth, same as proof links.
//
// Deliberately read-only. The customer's card goes from their browser
// straight to Stripe (Stripe.js confirms the PaymentIntent with its client
// secret); nothing card-related ever passes through this server, and the
// payment is recorded by the existing payment_intent.succeeded webhook.

'use strict';

const express = require('express');
const { queryOne } = require('../db/connection');
const { getStripe, stripeConfigured, publishableKey } = require('../lib/stripe-client');

const router = express.Router();

// GET /api/pay/:token
// → { status: 'open'|'paid'|'canceled', amountCents, jobId, description,
//     clientName, clientSecret?, publishableKey? }
router.get('/:token', async (req, res) => {
  const token = String(req.params.token || '');
  if (!/^[0-9a-f]{48}$/.test(token)) return res.status(404).json({ error: 'Link not found' });
  try {
    const row = await queryOne(
      `SELECT tp.*,
              COALESCE(c.company, CONCAT_WS(' ', c.fname, c.lname)) AS client_name
         FROM terminal_payments tp
         LEFT JOIN clients c ON c.id = tp.client_id
        WHERE tp.pay_token = $1 AND tp.channel = 'link'`,
      [token]
    );
    if (!row) return res.status(404).json({ error: 'Link not found' });

    const base = {
      amountCents: row.amount_cents,
      jobId:       row.project_id,
      description: row.description,
      clientName:  row.client_name || null,
    };
    if (['succeeded', 'refunded', 'partially_refunded'].includes(row.status)) {
      return res.json({ ...base, status: 'paid' });
    }
    if (row.status !== 'pending' || !stripeConfigured()) {
      return res.json({ ...base, status: 'canceled' });
    }

    // Ask Stripe rather than trusting the row: the webhook can be a few
    // seconds behind a payment that just went through.
    const pi = await getStripe().paymentIntents.retrieve(row.payment_intent_id);
    if (pi.status === 'succeeded' || pi.status === 'processing') {
      return res.json({ ...base, status: 'paid' });
    }
    if (pi.status === 'canceled') return res.json({ ...base, status: 'canceled' });

    res.json({
      ...base,
      status:         'open',
      clientSecret:   pi.client_secret,
      publishableKey: publishableKey(),
    });
  } catch (err) {
    console.error('[pay-links]', err.message);
    res.status(500).json({ error: 'Could not load this payment link. Please call us.' });
  }
});

module.exports = router;
