// routes/payment.js
//
// Customer-facing payment endpoints. Right now: card tokenization only.
//
// POST /api/payment/tokenize  — convert raw card details into an opaque
//                               Intuit token for /api/orders to charge.
//
// PCI scope: card data lands in this process for the duration of one
// HTTP request, gets forwarded to Intuit's tokens API, and is then
// dropped on the floor. Nothing is logged. Nothing is persisted. Keep
// it that way:
//
//   • Do NOT add request body logging to this file or to lib/qb-payments.js.
//   • Do NOT echo any field of the input back in error responses.
//   • Do NOT write the input to any database.
//
// Auth: requireCustomer — only logged-in customers can tokenize. This
// also gives us per-customer rate-limiting at a higher layer (when we
// add it) instead of a globally abusable open endpoint for card-testing.

'use strict';

const express = require('express');
const qbPayments = require('../lib/qb-payments');
const { requireCustomer } = require('../middleware/customer-auth');

const router = express.Router();

// Sanity-check helpers. Reject obviously bad input early so we don't
// even forward it to Intuit (saves API calls and removes any chance of
// a malformed payload bouncing back with our raw input echoed in the
// error body).
function isDigits(s, min, max) {
  return typeof s === 'string' && /^\d+$/.test(s) && s.length >= min && s.length <= max;
}
function parseExp(raw) {
  // Accept "MM/YY", "MM/YYYY", "MMYY", "MMYYYY" — return { expMonth, expYear }
  // with year normalized to 4 digits, or null if unparseable.
  if (typeof raw !== 'string') return null;
  const cleaned = raw.replace(/\s+/g, '');
  const m = cleaned.match(/^(\d{1,2})[\/\-]?(\d{2}|\d{4})$/);
  if (!m) return null;
  const mm = parseInt(m[1], 10);
  let   yy = m[2];
  if (mm < 1 || mm > 12) return null;
  if (yy.length === 2) {
    // Two-digit year: assume 2000-2099 (no card expires before 2000).
    yy = '20' + yy;
  }
  return { expMonth: String(mm).padStart(2, '0'), expYear: yy };
}

router.post('/tokenize', requireCustomer, async (req, res) => {
  // Extract & validate locally. NEVER reach into req.body inside an
  // error path; only echo specific safe fields (postal code, last4) if
  // we explicitly want to.
  const number = typeof req.body?.number === 'string'
    ? req.body.number.replace(/\s+/g, '')
    : '';
  const expRaw = req.body?.exp;
  const cvc    = typeof req.body?.cvc === 'string' ? req.body.cvc.trim() : '';
  const zip    = typeof req.body?.zip === 'string' ? req.body.zip.trim() : '';
  const name   = typeof req.body?.name === 'string' ? req.body.name.trim() : '';

  if (!isDigits(number, 12, 19)) {
    return res.status(400).json({ error: 'Invalid card number' });
  }
  if (cvc && !isDigits(cvc, 3, 4)) {
    return res.status(400).json({ error: 'Invalid CVC' });
  }
  if (!zip) {
    return res.status(400).json({ error: 'Postal code is required' });
  }
  const exp = parseExp(expRaw);
  if (!exp) {
    return res.status(400).json({ error: 'Invalid expiry (use MM/YY)' });
  }

  try {
    const result = await qbPayments.tokenize({
      number,
      expMonth: exp.expMonth,
      expYear:  exp.expYear,
      cvc:      cvc || undefined,
      name:     name || undefined,
      address: {
        postalCode: zip,
        country:    'CA',
      },
    });
    // Only the token + sanitized card metadata leave this endpoint.
    return res.json({
      token: result.token,
      brand: result.brand,
      last4: result.last4,
    });
  } catch (err) {
    // err.body comes from Intuit's response — safe to surface for
    // diagnostics on a card-decline (e.g. "card_declined", "expired_card").
    // err.message is sanitized in qbPayments.tokenize() so it doesn't
    // contain our request body. Log the SHAPE of the error, not the input.
    console.warn('[payment/tokenize] Intuit returned error', err.status || '?', err.body || err.message);
    const intuitMsg = err.body?.errors?.[0]?.message || err.body?.message;
    return res.status(err.status === 401 ? 502 : 400).json({
      error:  intuitMsg || 'Card could not be processed',
      detail: intuitMsg ? undefined : 'See server logs',
    });
  }
});

module.exports = router;
