// Internal payments bridge.
//
// Two endpoints, both mounted under /api/internal:
//
//   POST /tokenize-public
//     PUBLIC — called directly from the browser (holmgraphics.ca/advertise),
//     with cross-origin CORS allowed for our marketing origins.
//     Accepts a raw card payload, hands to Intuit's tokenize API, returns
//     an opaque token. Raw PAN never lives in our DB; it's forwarded
//     straight to Intuit and dropped.
//
//   POST /charge
//     INTERNAL — called server-to-server from the LED app at led.holmgraphics.ca.
//     Protected by a shared secret (LED_SHOP_BRIDGE_SECRET). Accepts a
//     token + amount, calls Intuit charge, returns charge metadata.
//
// Why "/api/internal" instead of extending /api/payment? The existing
// /api/payment routes require either customer or staff auth — neither of
// which applies for a public ad-rental flow. Keeping these on their own
// path makes the security boundary obvious and avoids loosening anything
// that already works.

'use strict';

const express = require('express');
const cors = require('cors');
const qbPayments = require('../lib/qb-payments');

const router = express.Router();

// ─── CORS allowlist for the public tokenize endpoint ──────────────────────────
//
// This is more permissive than the app-wide CORS because the rental booking
// flow on holmgraphics.ca/advertise is unauthenticated and needs to hit us
// cross-origin. The /charge endpoint below is still server-to-server only
// and gated by the X-Internal-Key header check, so opening up CORS here
// doesn't help an attacker do anything they couldn't do with curl.
const publicOrigins = [
  'https://holmgraphics.ca',
  'https://www.holmgraphics.ca',
  'https://led.holmgraphics.ca',
  'http://localhost:5173',
  'http://localhost:5174',
  'http://localhost:8080',
];
const publicCors = cors({
  origin: (origin, cb) => {
    if (!origin) return cb(null, true);
    if (publicOrigins.includes(origin)) return cb(null, true);
    cb(new Error(`CORS blocked: ${origin}`));
  },
  credentials: false,
});

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Parse an "MM/YY" or "MM/YYYY" expiry string into { expMonth, expYear }.
 * Returns null if unparseable. We accept both for browser convenience.
 */
function parseExpiry(exp) {
  if (!exp || typeof exp !== 'string') return null;
  const m = exp.replace(/\s+/g, '').match(/^(\d{1,2})\/(\d{2,4})$/);
  if (!m) return null;
  const mm = parseInt(m[1], 10);
  let yy = parseInt(m[2], 10);
  if (yy < 100) yy += 2000;
  if (mm < 1 || mm > 12) return null;
  if (yy < 2020 || yy > 2099) return null;
  return { expMonth: String(mm).padStart(2, '0'), expYear: String(yy) };
}

// ─── POST /tokenize-public ────────────────────────────────────────────────────

router.options('/tokenize-public', publicCors);
router.post('/tokenize-public', publicCors, async (req, res) => {
  const { number, exp, cvc, zip, name } = req.body || {};

  if (!number || typeof number !== 'string' || number.replace(/\s+/g, '').length < 12) {
    return res.status(400).json({ error: 'card number is required' });
  }
  const expParsed = parseExpiry(exp);
  if (!expParsed) {
    return res.status(400).json({ error: 'expiry must be MM/YY or MM/YYYY' });
  }
  if (!zip || typeof zip !== 'string' || zip.trim().length < 3) {
    return res.status(400).json({ error: 'postal/zip code is required (for AVS)' });
  }

  try {
    const result = await qbPayments.tokenize({
      number: number.replace(/\s+/g, ''),
      expMonth: expParsed.expMonth,
      expYear: expParsed.expYear,
      cvc: cvc || undefined,
      name: name || undefined,
      address: {
        country: 'CA',
        postalCode: String(zip).trim().toUpperCase(),
      },
    });
    return res.json(result);
  } catch (err) {
    // qb-payments already sanitizes its error messages, but be defensive.
    const status = err.status === 401 || err.status === 403 ? 502 : 400;
    return res.status(status).json({
      error: err.message || 'tokenize failed',
    });
  }
});

// ─── POST /charge (server-to-server only) ─────────────────────────────────────

function requireInternalKey(req, res, next) {
  const expected = process.env.LED_SHOP_BRIDGE_SECRET;
  if (!expected) {
    return res.status(503).json({ error: 'internal bridge not configured (LED_SHOP_BRIDGE_SECRET missing)' });
  }
  const got = req.get('X-Internal-Key') || req.get('x-internal-key');
  if (!got || got !== expected) {
    return res.status(401).json({ error: 'invalid internal key' });
  }
  next();
}

router.post('/charge', requireInternalKey, async (req, res) => {
  const { token, amount, currency, description, requestId } = req.body || {};

  if (!token || typeof token !== 'string') {
    return res.status(400).json({ error: 'token is required' });
  }
  const amt = Number(amount);
  if (!Number.isFinite(amt) || amt <= 0) {
    return res.status(400).json({ error: 'amount must be a positive number (in dollars)' });
  }

  try {
    const result = await qbPayments.charge({
      token,
      amount: amt,
      currency: currency || 'CAD',
      description: description || undefined,
      requestId: requestId || undefined,
    });
    return res.json(result);
  } catch (err) {
    // Map Intuit decline to 402 so the LED app's coex pipeline maps it to a
    // user-facing "card declined" message instead of a generic 502.
    const isDecline =
      err.status === 402 ||
      /decline/i.test(err.message || '') ||
      /CARD_DECLINED/i.test(JSON.stringify(err.body || ''));
    const status = isDecline ? 402 : 502;
    return res.status(status).json({
      error: err.message || 'charge failed',
    });
  }
});

module.exports = router;
