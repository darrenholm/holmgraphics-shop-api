// routes/internal-payments.js
//
// Bridge endpoints that let other Holm Graphics services (currently: the LED
// rental marketplace at led.holmgraphics.ca) reuse this API's QuickBooks
// Payments integration without standing up their own Intuit OAuth flow.
//
// Two endpoints, both mounted at /api/internal:
//
//   POST /tokenize-public     — public, no JWT, rate-limited per-IP. Wraps
//                               qbPayments.tokenize so a renter can convert
//                               a card on the LED rental site (which has no
//                               customer login).
//
//   POST /charge              — server-to-server only. Requires the
//                               X-Internal-Key header to match
//                               LED_SHOP_BRIDGE_SECRET. The LED app calls
//                               this from its backend after a token has been
//                               obtained on the frontend.
//
// Why split tokenize from charge?
//
//   • Tokenize must run with the card data still in the browser → has to be
//     reachable from led.holmgraphics.ca directly (CORS). Public-but-rate-
//     limited keeps PCI scope tight: card data lives in this process for
//     one request and is dropped.
//
//   • Charge uses the opaque token; it doesn't need to touch card data at
//     all. We can therefore gate it with a shared secret instead of a
//     customer JWT, which keeps the public LED rental flow simple while
//     still preventing arbitrary callers from charging tokens.

'use strict';

const express = require('express');
const qbPayments = require('../lib/qb-payments');

const router = express.Router();

// Bound to roughly one tokenize per second per IP after a small burst.
// Hand-rolled (no rate-limit dep here yet) because the existing payment
// route doesn't use one and we don't want to add a new dep just for this.
const TOKENIZE_LIMIT = { burst: 5, perMinute: 30 };
const tokenizeBuckets = new Map(); // ip -> { tokens, refilledAt }

function tokenizeRateLimit(req, res, next) {
  const ip = req.headers['x-forwarded-for']?.toString().split(',')[0].trim()
          || req.socket.remoteAddress
          || 'unknown';
  const now = Date.now();
  const bucket = tokenizeBuckets.get(ip) ?? { tokens: TOKENIZE_LIMIT.burst, refilledAt: now };
  const elapsedMs = now - bucket.refilledAt;
  const refill = (elapsedMs / 60_000) * TOKENIZE_LIMIT.perMinute;
  bucket.tokens = Math.min(TOKENIZE_LIMIT.burst + TOKENIZE_LIMIT.perMinute, bucket.tokens + refill);
  bucket.refilledAt = now;
  if (bucket.tokens < 1) {
    tokenizeBuckets.set(ip, bucket);
    return res.status(429).json({ error: 'Too many tokenize attempts; slow down' });
  }
  bucket.tokens -= 1;
  tokenizeBuckets.set(ip, bucket);
  next();
}

// Same input validation as routes/payment.js — keep these in sync.
function isDigits(s, min, max) {
  return typeof s === 'string' && /^\d+$/.test(s) && s.length >= min && s.length <= max;
}
function parseExp(raw) {
  if (typeof raw !== 'string') return null;
  const cleaned = raw.replace(/\s+/g, '');
  const m = cleaned.match(/^(\d{1,2})[\/\-]?(\d{2}|\d{4})$/);
  if (!m) return null;
  const mm = parseInt(m[1], 10);
  let yy = m[2];
  if (mm < 1 || mm > 12) return null;
  if (yy.length === 2) yy = '20' + yy;
  return { expMonth: String(mm).padStart(2, '0'), expYear: yy };
}

// ─── Public tokenize (no auth, rate-limited) ─────────────────────────────────
//
// Same body shape as POST /api/payment/tokenize. Card data lands in this
// process for the duration of the request, gets forwarded to Intuit, and is
// then dropped. Do NOT log request bodies or echo card fields back in errors.

router.post('/tokenize-public', tokenizeRateLimit, async (req, res) => {
  const number = typeof req.body?.number === 'string' ? req.body.number.replace(/\s+/g, '') : '';
  const expRaw = req.body?.exp;
  const cvc    = typeof req.body?.cvc === 'string' ? req.body.cvc.trim() : '';
  const zip    = typeof req.body?.zip === 'string' ? req.body.zip.trim() : '';
  const name   = typeof req.body?.name === 'string' ? req.body.name.trim() : '';

  if (!isDigits(number, 12, 19)) return res.status(400).json({ error: 'Invalid card number' });
  if (cvc && !isDigits(cvc, 3, 4))  return res.status(400).json({ error: 'Invalid CVC' });
  if (!zip) return res.status(400).json({ error: 'Postal code is required' });
  const exp = parseExp(expRaw);
  if (!exp) return res.status(400).json({ error: 'Invalid expiry (use MM/YY)' });

  try {
    const result = await qbPayments.tokenize({
      number,
      expMonth: exp.expMonth,
      expYear:  exp.expYear,
      cvc:      cvc || undefined,
      name:     name || undefined,
      address:  { postalCode: zip, country: 'CA' },
    });
    return res.json({
      token: result.token,
      brand: result.brand,
      last4: result.last4,
    });
  } catch (e) {
    // Don't echo any request fields in the error.
    return res.status(502).json({ error: 'Tokenization failed' });
  }
});

// ─── Internal charge (shared-secret) ─────────────────────────────────────────

function requireInternalKey(req, res, next) {
  const expected = process.env.LED_SHOP_BRIDGE_SECRET;
  if (!expected) {
    return res.status(503).json({ error: 'Internal bridge not configured' });
  }
  const got = req.headers['x-internal-key'];
  if (typeof got !== 'string' || got !== expected) {
    return res.status(401).json({ error: 'Invalid internal key' });
  }
  next();
}

router.post('/charge', requireInternalKey, async (req, res) => {
  const { token, amount, currency, description, requestId } = req.body ?? {};
  if (typeof token !== 'string' || !token) {
    return res.status(400).json({ error: 'token required' });
  }
  if (typeof amount !== 'number' || !(amount > 0)) {
    return res.status(400).json({ error: 'amount must be a positive number (in dollars)' });
  }
  try {
    const result = await qbPayments.charge({
      token,
      amount,
      currency: currency || 'CAD',
      description: typeof description === 'string' ? description : undefined,
      requestId:   typeof requestId   === 'string' ? requestId   : undefined,
    });
    if (!result.ok) {
      return res.status(402).json({
        error: 'Charge declined',
        status: result.status,
        charge_id: result.charge_id,
      });
    }
    return res.json({
      ok: true,
      charge_id: result.charge_id,
      status:    result.status,
      amount:    result.amount,
      currency:  result.currency,
      card_brand: result.card_brand,
      card_last4: result.card_last4,
      auth_code:  result.auth_code,
    });
  } catch (e) {
    // eslint-disable-next-line no-console
    console.error('[internal-payments] charge failed:', e?.message || e);
    return res.status(502).json({ error: 'Charge failed' });
  }
});

module.exports = router;
