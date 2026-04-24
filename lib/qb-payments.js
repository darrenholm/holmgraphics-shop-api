// lib/qb-payments.js
// QB Payments API client. Handles inline card charges and refunds for the
// DTF online store. Uses the same OAuth tokens as QBO accounting (shared
// via lib/qbo-tokens.js).
//
// Card tokenization happens on the customer's browser via Intuit's JS SDK
// (intuit.ipp.payments) so raw card numbers never reach our server. The
// frontend posts only the resulting `token` to our /api/orders endpoint,
// which calls into this library to actually charge.
//
// Endpoints used:
//   POST /quickbooks/v4/payments/charges          (charge a card token)
//   POST /quickbooks/v4/payments/charges/:id/refunds  (refund all or part)
//   GET  /quickbooks/v4/payments/charges/:id      (lookup charge status)
//
// All amounts are CAD dollars in / out (strings like "12.50" on the wire,
// but this module accepts numbers and serializes them).
//
// 3D Secure: QB Payments handles 3DS challenges in the JS SDK. If a
// customer's bank requires 3DS, the SDK shows the challenge and only then
// gives the frontend a token usable here. We don't need server-side 3DS
// handling.

'use strict';

const crypto = require('crypto');
const { activeTokens } = require('./qbo-tokens');

function PAYMENTS_BASE() {
  // Sandbox vs production split. Same env switch as QBO accounting.
  return process.env.NODE_ENV === 'production'
    ? 'https://api.intuit.com'
    : 'https://sandbox.api.intuit.com';
}

function formatAmount(n) {
  // QB Payments wants amounts as strings with two decimals.
  if (typeof n === 'string') return n;
  if (!Number.isFinite(n)) throw new Error('Invalid amount');
  return n.toFixed(2);
}

async function request(method, path, body) {
  const t = await activeTokens();
  // Each request needs an idempotency key — Intuit dedupes retries within
  // 24 hours by this header. Generate fresh per call unless caller supplies.
  const requestId = (body && body.__requestId) || crypto.randomUUID();
  if (body && body.__requestId) delete body.__requestId;

  const headers = {
    'Authorization':  `Bearer ${t.access_token}`,
    'Accept':         'application/json',
    'Request-Id':     requestId,
  };
  const init = { method, headers };
  if (body !== undefined) {
    headers['Content-Type'] = 'application/json';
    init.body = JSON.stringify(body);
  }

  const res = await fetch(`${PAYMENTS_BASE()}${path}`, init);
  const text = await res.text();
  let parsed;
  try { parsed = text ? JSON.parse(text) : null; } catch { parsed = text; }
  if (!res.ok) {
    const err = new Error(`QB Payments ${res.status}: ${typeof parsed === 'string' ? parsed : JSON.stringify(parsed)}`);
    err.status = res.status;
    err.body   = parsed;
    throw err;
  }
  return parsed;
}

// ─── Charge ──────────────────────────────────────────────────────────────────

// Charge a card token. Returns a normalized result.
//
// Args:
//   token            (string)  card token from Intuit JS SDK
//   amount           (number)  CAD dollars, e.g. 12.50
//   currency         (string)  defaults 'CAD'
//   capture          (bool)    true = charge now (default); false = auth only
//   description      (string)  shows on QB transactions list
//   requestId        (string)  optional idempotency key
//
// Returns:
//   { ok, status: 'CAPTURED'|'DECLINED'|'AUTHORIZED', charge_id, amount,
//     currency, card_brand, card_last4, raw }
async function charge({ token, amount, currency = 'CAD', capture = true, description, requestId }) {
  if (!token) throw new Error('charge requires a token');

  const body = {
    amount:   formatAmount(amount),
    currency,
    capture,
    token,
    context: {
      mobile:      false,
      isEcommerce: true,
    },
  };
  if (description) body.description = description.slice(0, 4000);
  if (requestId)   body.__requestId = requestId;

  const resp = await request('POST', '/quickbooks/v4/payments/charges', body);

  return {
    ok:          resp.status === 'CAPTURED' || resp.status === 'AUTHORIZED',
    status:      resp.status,
    charge_id:   resp.id,
    amount:      Number(resp.amount),
    currency:    resp.currency,
    card_brand:  resp.card?.cardType || resp.card?.name,
    card_last4:  resp.card?.number,           // QB returns last 4 only
    auth_code:   resp.authCode,
    avs_street:  resp.avsStreet,
    avs_zip:     resp.avsZip,
    raw:         resp,
  };
}

// ─── Refund ──────────────────────────────────────────────────────────────────

// Refund a previous charge. amount omitted = full refund.
//
// Args:
//   chargeId         (string)  the charge_id from a previous charge() call
//   amount           (number?) CAD dollars; omit for full refund
//   description      (string?)
//   requestId        (string?) idempotency key
//
// Returns:
//   { ok, status: 'ISSUED'|'PENDING'|'DECLINED', refund_id, amount, raw }
async function refund({ chargeId, amount, description, requestId }) {
  if (!chargeId) throw new Error('refund requires chargeId');

  const body = {
    context: {
      mobile:      false,
      isEcommerce: true,
    },
  };
  if (amount != null)  body.amount = formatAmount(amount);
  if (description)     body.description = description.slice(0, 4000);
  if (requestId)       body.__requestId = requestId;

  const resp = await request(
    'POST',
    `/quickbooks/v4/payments/charges/${encodeURIComponent(chargeId)}/refunds`,
    body
  );

  return {
    ok:        resp.status === 'ISSUED' || resp.status === 'PENDING',
    status:    resp.status,
    refund_id: resp.id,
    amount:    Number(resp.amount),
    raw:       resp,
  };
}

// ─── Lookup ──────────────────────────────────────────────────────────────────

async function getCharge(chargeId) {
  return request('GET', `/quickbooks/v4/payments/charges/${encodeURIComponent(chargeId)}`);
}

module.exports = {
  charge,
  refund,
  getCharge,
  // exported for tests
  _internals: { formatAmount, PAYMENTS_BASE },
};
