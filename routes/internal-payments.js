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
const qboSync = require('../lib/qbo-sync');
const { query, queryOne } = require('../db/connection');

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

// ─── POST /upsert-client (server-to-server only) ──────────────────────────────
//
// Find-or-create a client row keyed primarily by email. If business is
// provided, prefer matching on (email + company) so two different orgs sharing
// a personal email don't collide. Returns the client id either way.

router.post('/upsert-client', requireInternalKey, async (req, res) => {
  const { email, name, business, phone } = req.body || {};
  if (!email || typeof email !== 'string') {
    return res.status(400).json({ error: 'email is required' });
  }
  const normEmail = email.trim().toLowerCase();
  const company = (business || '').trim();
  const fullName = (name || '').trim();

  try {
    // Match strategy:
    //   1. If business given: exact company + email match.
    //   2. Otherwise: email match where company is null/blank (so we don't
    //      attach a personal booking onto an unrelated business client).
    let match;
    if (company) {
      match = await queryOne(
        `SELECT id FROM clients
          WHERE LOWER(email) = $1
            AND LOWER(COALESCE(company, '')) = LOWER($2)
          LIMIT 1`,
        [normEmail, company],
      );
    } else {
      match = await queryOne(
        `SELECT id FROM clients
          WHERE LOWER(email) = $1
            AND (company IS NULL OR company = '')
          LIMIT 1`,
        [normEmail],
      );
    }
    if (match) {
      return res.json({ id: match.id, created: false });
    }

    // Split "First Last" → fname / lname for individuals.
    let fname = null;
    let lname = null;
    if (fullName) {
      const parts = fullName.split(/\s+/);
      fname = parts.shift() || null;
      lname = parts.length > 0 ? parts.join(' ') : null;
    }

    const created = await queryOne(
      `INSERT INTO clients (company, fname, lname, email)
       VALUES ($1, $2, $3, $4)
       RETURNING id`,
      [company || null, fname, lname, normEmail],
    );
    return res.status(201).json({ id: created.id, created: true });
  } catch (err) {
    console.error('[/api/internal/upsert-client]', err);
    return res.status(500).json({ error: err.message || 'upsert-client failed' });
  }
});

// ─── POST /create-project (server-to-server only) ─────────────────────────────
//
// Mints a new project row. Used by the LED ad-rental flow on payment so the
// rental shows up alongside regular jobs on the staff jobs board.

router.post('/create-project', requireInternalKey, async (req, res) => {
  const {
    clientId,
    description,
    contactName,
    contactPhone,
    contactEmail,
    statusId,
    projectTypeId,
    dueDate,
    poNumber,
  } = req.body || {};

  if (!clientId || !Number.isFinite(Number(clientId))) {
    return res.status(400).json({ error: 'clientId is required (integer)' });
  }
  if (!description || typeof description !== 'string') {
    return res.status(400).json({ error: 'description is required' });
  }

  try {
    const row = await queryOne(
      `INSERT INTO projects (
          description, client_id, project_type_id, status_id,
          contact_name, contact_phone, contact_email,
          due_date, po_number, created_date
       ) VALUES (
          $1, $2, $3, $4,
          $5, $6, $7,
          $8, $9, CURRENT_DATE
       )
       RETURNING id`,
      [
        description,
        parseInt(clientId, 10),
        projectTypeId ? parseInt(projectTypeId, 10) : null,
        statusId ? parseInt(statusId, 10) : 2,   // 2 = "Ordered" — paid + awaiting work
        contactName || null,
        contactPhone || null,
        contactEmail || null,
        dueDate ? new Date(dueDate) : null,
        poNumber ? String(poNumber).trim() || null : null,
      ],
    );
    return res.status(201).json({ id: row.id });
  } catch (err) {
    console.error('[/api/internal/create-project]', err);
    return res.status(500).json({ error: err.message || 'create-project failed' });
  }
});

// ─── POST /create-sales-receipt (server-to-server only) ───────────────────────
//
// Mints a QBO Sales Receipt for an already-charged ad rental. Unlike the
// orders pipeline (which has its own table + qbo_invoice_id column), this
// endpoint is fire-and-forget for callers like the LED app: pass in the
// charge metadata and we'll write the receipt. The returned id is for the
// caller to persist if they want traceability.
//
// Idempotency lives in the caller: pass the same paymentRef twice and QBO
// will (politely) create two receipts. We don't try to de-dupe here.

router.post('/create-sales-receipt', requireInternalKey, async (req, res) => {
  const {
    clientId,
    lineDescription,
    amountCents,
    currency,             // accepted but advisory — QBO uses the company's home currency
    paymentRef,           // QB Payments charge id, stamped onto the receipt
    chargeDate,           // ISO date or datetime; defaults to today
  } = req.body || {};

  if (!clientId || !Number.isFinite(Number(clientId))) {
    return res.status(400).json({ error: 'clientId is required (integer)' });
  }
  if (!lineDescription || typeof lineDescription !== 'string') {
    return res.status(400).json({ error: 'lineDescription is required' });
  }
  const cents = Number(amountCents);
  if (!Number.isFinite(cents) || cents <= 0) {
    return res.status(400).json({ error: 'amountCents must be a positive integer' });
  }

  try {
    // 1. Load the clients row so ensureQboCustomer can either reuse the
    //    cached qb_customer_id or auto-create the customer in QBO.
    const client = await queryOne(
      `SELECT id, company, fname, lname, email, qb_customer_id
         FROM clients
        WHERE id = $1`,
      [parseInt(clientId, 10)],
    );
    if (!client) {
      return res.status(404).json({ error: `client ${clientId} not found` });
    }

    const qbCustomerId = await qboSync.ensureQboCustomer(client);
    // Book LED ad rentals against the dedicated ComMarketBoard item so the
    // income posts to its own ledger. Falls back to Misc internally if the
    // named item isn't set up in QBO yet.
    const itemId       = await qboSync.findComMarketBoardItemId();

    const amountDollars = cents / 100;
    const txnDate = (() => {
      try { return new Date(chargeDate || Date.now()).toISOString().slice(0, 10); }
      catch { return new Date().toISOString().slice(0, 10); }
    })();

    // Single line item — keeps the receipt clean and matches the way
    // rentals show up on the staff jobs board ("LED ad rental on <device>").
    const Line = [{
      Amount:      amountDollars,
      DetailType:  'SalesItemLineDetail',
      Description: String(lineDescription).slice(0, 4000),
      SalesItemLineDetail: {
        ItemRef:    { value: itemId },
        UnitPrice:  amountDollars,
        Qty:        1,
        TaxCodeRef: { value: '7' }, // matches the order-receipt convention
      },
    }];

    const payload = {
      CustomerRef: { value: qbCustomerId },
      TxnDate:     txnDate,
      PrivateNote:
        `LED ad rental` +
        (paymentRef ? ` — QB Payments charge ${paymentRef}` : ''),
      ...(paymentRef ? { PaymentRefNum: String(paymentRef).slice(0, 21) } : {}),
      Line,
      TxnTaxDetail: {
        TxnTaxCodeRef: { value: '7' },
        TotalTax:      0,
      },
      ...(client.email ? { BillEmail: { Address: client.email } } : {}),
    };

    const result = await qboSync.qbPost('/salesreceipt?minorversion=65', payload);
    const qboId = result?.SalesReceipt?.Id;
    if (!qboId) {
      throw new Error('QBO did not return a SalesReceipt Id');
    }
    return res.status(201).json({ id: qboId });
  } catch (err) {
    console.error('[/api/internal/create-sales-receipt]', err);
    // QBO 401/403 → 502 so the caller knows it's a token problem, not their input.
    const isAuth = err.status === 401 || err.status === 403;
    return res.status(isAuth ? 502 : 500).json({
      error: err.message || 'create-sales-receipt failed',
      ...(err.qbCode ? { qbCode: err.qbCode } : {}),
    });
  }
});

module.exports = router;
