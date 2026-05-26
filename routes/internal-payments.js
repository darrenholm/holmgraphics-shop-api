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
const crypto = require('crypto');
const qbPayments = require('../lib/qb-payments');
const qboSync = require('../lib/qbo-sync');
const filesBridge = require('../lib/files-bridge-client');
const mailer = require('../lib/customer-mailer');
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

// ─── POST /lookup-client (server-to-server only) ──────────────────────────────
//
// Used by the LED app's self-serve ad portal: when an advertiser tries to
// swap their on-screen artwork, the LED app calls this to look up the
// trust_self_serve_ads flag and decide whether the swap should publish
// instantly or move the rental back to pending_review for admin approval.
//
// Read-only; takes no PII risk. Still gated by X-Internal-Key so the flag
// can't be probed from the public internet.

router.post('/lookup-client', requireInternalKey, async (req, res) => {
  const { clientId } = req.body || {};
  if (!clientId || !Number.isFinite(Number(clientId))) {
    return res.status(400).json({ error: 'clientId is required (integer)' });
  }
  try {
    const row = await queryOne(
      `SELECT id, email, company, fname, lname, trust_self_serve_ads
         FROM clients
        WHERE id = $1`,
      [parseInt(clientId, 10)],
    );
    if (!row) {
      return res.status(404).json({ error: `client ${clientId} not found` });
    }
    return res.json({
      id:                    row.id,
      email:                 row.email,
      company:               row.company,
      name:                  [row.fname, row.lname].filter(Boolean).join(' ') ||
                             row.company || row.email,
      trust_self_serve_ads:  row.trust_self_serve_ads !== false, // default true if column missing
    });
  } catch (err) {
    console.error('[/api/internal/lookup-client]', err);
    return res.status(500).json({ error: err.message || 'lookup-client failed' });
  }
});

// ─── POST /set-client-trust (server-to-server only) ───────────────────────────
//
// Lets the LED admin UI flip clients.trust_self_serve_ads from the rental
// detail page without needing to hop into the shop-api admin. Audit log
// lives in QBO / payment history; we don't keep a per-flag history here.

router.post('/set-client-trust', requireInternalKey, async (req, res) => {
  const { clientId, trust } = req.body || {};
  if (!clientId || !Number.isFinite(Number(clientId))) {
    return res.status(400).json({ error: 'clientId is required (integer)' });
  }
  if (typeof trust !== 'boolean') {
    return res.status(400).json({ error: 'trust must be a boolean' });
  }
  try {
    const row = await queryOne(
      `UPDATE clients
          SET trust_self_serve_ads = $1
        WHERE id = $2
       RETURNING id, trust_self_serve_ads`,
      [trust, parseInt(clientId, 10)],
    );
    if (!row) {
      return res.status(404).json({ error: `client ${clientId} not found` });
    }
    return res.json({ id: row.id, trust_self_serve_ads: row.trust_self_serve_ads });
  } catch (err) {
    console.error('[/api/internal/set-client-trust]', err);
    return res.status(500).json({ error: err.message || 'set-client-trust failed' });
  }
});

// ─── POST /search-clients (server-to-server only) ─────────────────────────────
//
// Lightweight client lookup for the LED admin's "Add ad contract" modal.
// Accepts a single `q` string and returns up to `limit` matches across
// email / company / first / last name. Read-only.

router.post('/search-clients', requireInternalKey, async (req, res) => {
  const { q, limit } = req.body || {};
  const term = (q || '').toString().trim();
  if (term.length < 2) {
    return res.status(400).json({ error: 'q must be at least 2 characters' });
  }
  const lim = Math.min(Math.max(parseInt(limit, 10) || 20, 1), 100);
  const like = `%${term.toLowerCase()}%`;
  try {
    const rows = await query(
      `SELECT id, email, company, fname, lname
         FROM clients
        WHERE LOWER(COALESCE(email, ''))   LIKE $1
           OR LOWER(COALESCE(company, '')) LIKE $1
           OR LOWER(COALESCE(fname, ''))   LIKE $1
           OR LOWER(COALESCE(lname, ''))   LIKE $1
        ORDER BY
          CASE
            WHEN LOWER(COALESCE(company, '')) = $2 THEN 0
            WHEN LOWER(COALESCE(email,   '')) = $2 THEN 1
            ELSE 2
          END,
          company NULLS LAST,
          lname   NULLS LAST,
          fname   NULLS LAST
        LIMIT $3`,
      [like, term.toLowerCase(), lim],
    );
    return res.json({
      clients: rows.map((r) => ({
        id:      r.id,
        email:   r.email,
        company: r.company,
        name:    [r.fname, r.lname].filter(Boolean).join(' ') || r.company || r.email,
      })),
    });
  } catch (err) {
    console.error('[/api/internal/search-clients]', err);
    return res.status(500).json({ error: err.message || 'search-clients failed' });
  }
});

// ─── POST /mirror-ad-artwork (server-to-server only) ──────────────────────────
//
// Mirrors an LED ad creative from the LED app's storage (Railway volume) into
// the client's L:\ files folder. Called best-effort by the LED app after a
// rental's artwork is set. The LED app keeps its own copy (VNNOX pulls from
// there) — this just makes the file visible to staff browsing the client
// folder in Windows Explorer.
//
// Body: { sourceUrl, clientId, contractRef, filename, mimeType? }
//   sourceUrl   — fetchable URL where the artwork currently lives
//                 (e.g. https://led.holmgraphics.ca/files/uploads/abc.png)
//   clientId    — shop-api.clients.id
//   contractRef — short stable label (typically contract uuid prefix)
//   filename    — desired on-disk filename (will be sanitized)
//
// Returns the L:\ path the file landed at. If files-bridge isn't configured
// or is unreachable, returns 503 — the LED caller is expected to log and
// move on (the rental still works without the mirror).

router.post('/mirror-ad-artwork', requireInternalKey, async (req, res) => {
  const { sourceUrl, clientId, contractRef, filename, mimeType } = req.body || {};

  if (!sourceUrl || typeof sourceUrl !== 'string') {
    return res.status(400).json({ error: 'sourceUrl is required' });
  }
  if (!clientId || !Number.isFinite(Number(clientId))) {
    return res.status(400).json({ error: 'clientId is required (integer)' });
  }
  if (!contractRef || !/^[A-Za-z0-9_.\-]+$/.test(String(contractRef))) {
    return res.status(400).json({ error: 'contractRef must match [A-Za-z0-9_.-]+' });
  }
  if (!filename || typeof filename !== 'string') {
    return res.status(400).json({ error: 'filename is required' });
  }
  if (!process.env.FILES_BRIDGE_URL || !process.env.FILES_BRIDGE_API_KEY) {
    return res.status(503).json({ error: 'files-bridge not configured' });
  }

  try {
    // 1. Load the client so we can build the on-disk folder name.
    const client = await queryOne(
      `SELECT id, email, company, fname, lname FROM clients WHERE id = $1`,
      [parseInt(clientId, 10)],
    );
    if (!client) {
      return res.status(404).json({ error: `client ${clientId} not found` });
    }
    // Folder naming priority: company > "First Last" > email local part.
    // Matches the convention used elsewhere in the shop.
    const clientFolderName =
      (client.company && client.company.trim()) ||
      [client.fname, client.lname].filter(Boolean).join(' ').trim() ||
      (client.email ? client.email.split('@')[0] : null);
    if (!clientFolderName) {
      return res.status(400).json({ error: `client ${clientId} has no name/company/email to derive a folder from` });
    }

    // 2. Pull the artwork bytes. Use a HEAD-then-GET to surface size early
    //    and to inherit Content-Type if the caller didn't pass mimeType.
    const fetchRes = await fetch(sourceUrl);
    if (!fetchRes.ok) {
      return res.status(502).json({ error: `source fetch failed: ${fetchRes.status}` });
    }
    const fileBuffer = Buffer.from(await fetchRes.arrayBuffer());
    const inferredMime = fetchRes.headers.get('content-type') || mimeType || 'application/octet-stream';

    // 3. Push to files-bridge.
    const result = await filesBridge.uploadAdFile({
      clientName:  clientFolderName,
      contractRef: String(contractRef),
      fileName:    filename,
      fileBuffer,
      mimeType:    (mimeType && mimeType.trim()) || inferredMime,
    });
    return res.json({
      ok:           true,
      clientFolder: result.clientFolder,
      contractFolder: result.contractFolder,
      path:         result.path,
      size:         result.size,
    });
  } catch (err) {
    console.error('[/api/internal/mirror-ad-artwork]', err);
    return res.status(500).json({ error: err.message || 'mirror-ad-artwork failed' });
  }
});

// ─── POST /create-rental-invoice (server-to-server only) ──────────────────────
//
// Mints a QBO Invoice for a contract renewal. Unlike create-sales-receipt
// (which records a charge that already happened), this creates an unpaid
// Invoice with a DueDate and tells QBO to email it to the customer.
//
// Idempotency lives in the caller: pass the same contractRef twice and you
// get two invoices. The LED app's renewal cron should stamp
// ad_contracts.renewal_invoice_id immediately after a successful call so
// it doesn't double-bill.
//
// Body: { clientId, contractRef, lineDescription, amountCents, dueDate?,
//         billingEmail? }

router.post('/create-rental-invoice', requireInternalKey, async (req, res) => {
  const { clientId, contractRef, lineDescription, amountCents, dueDate, billingEmail } = req.body || {};

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
    const client = await queryOne(
      `SELECT id, company, fname, lname, email, qb_customer_id
         FROM clients WHERE id = $1`,
      [parseInt(clientId, 10)],
    );
    if (!client) {
      return res.status(404).json({ error: `client ${clientId} not found` });
    }

    const billTo = (billingEmail && String(billingEmail).trim()) || client.email || null;
    const qbCustomerId = await qboSync.ensureQboCustomer(client, billTo ? { email: billTo } : {});
    const itemId       = await qboSync.findComMarketBoardItemId();

    const amountDollars = cents / 100;
    const txnDate = new Date().toISOString().slice(0, 10);
    const due = (() => {
      if (!dueDate) return null;
      try { return new Date(dueDate).toISOString().slice(0, 10); }
      catch { return null; }
    })();

    const Line = [{
      Amount:      amountDollars,
      DetailType:  'SalesItemLineDetail',
      Description: String(lineDescription).slice(0, 4000),
      SalesItemLineDetail: {
        ItemRef:    { value: itemId },
        UnitPrice:  amountDollars,
        Qty:        1,
        TaxCodeRef: { value: '7' },
      },
    }];

    const payload = {
      CustomerRef: { value: qbCustomerId },
      TxnDate:     txnDate,
      ...(due ? { DueDate: due } : {}),
      PrivateNote: `LED ad rental renewal` + (contractRef ? ` — contract ${contractRef}` : ''),
      Line,
      TxnTaxDetail: {
        TxnTaxCodeRef: { value: '7' },
        TotalTax:      0,
      },
      // Telling QBO to email the invoice automatically — same pattern as
      // createInvoiceFromOrder.
      ...(billTo
        ? { BillEmail: { Address: billTo }, EmailStatus: 'NeedToSend' }
        : {}),
    };

    const result = await qboSync.qbPost('/invoice?minorversion=65', payload);
    const qboId = result?.Invoice?.Id;
    if (!qboId) {
      throw new Error('QBO did not return an Invoice Id');
    }
    return res.status(201).json({ id: qboId, billEmail: billTo });
  } catch (err) {
    console.error('[/api/internal/create-rental-invoice]', err);
    const isAuth = err.status === 401 || err.status === 403;
    return res.status(isAuth ? 502 : 500).json({
      error: err.message || 'create-rental-invoice failed',
      ...(err.qbCode ? { qbCode: err.qbCode } : {}),
    });
  }
});

// ─── POST /send-customer-activation (server-to-server only) ──────────────────
//
// Triggers the customer activation email for a client by id. Used by the
// LED app on contract create so the school/ad-client gets a "set up your
// login" email automatically — they click the link, set a password, and
// land on /advertise/my-ads with their screen already visible.
//
// Idempotent in the soft sense: if the account is already active, we
// don't re-send (returns alreadyActive=true). If the client has no email
// on file, we report hasEmail=false so the caller can flag it.

router.post('/send-customer-activation', requireInternalKey, async (req, res) => {
  const { clientId, returnPath } = req.body || {};
  if (!clientId || !Number.isFinite(Number(clientId))) {
    return res.status(400).json({ error: 'clientId is required (integer)' });
  }
  try {
    const client = await queryOne(
      `SELECT id, email, fname, account_status FROM clients WHERE id = $1`,
      [parseInt(clientId, 10)]
    );
    if (!client) {
      return res.status(404).json({ error: `client ${clientId} not found` });
    }
    if (!client.email) {
      return res.json({ sent: false, hasEmail: false, alreadyActive: false });
    }
    if (client.account_status === 'active') {
      return res.json({ sent: false, hasEmail: true, alreadyActive: true });
    }

    // urlSafeToken in customer-auth.js uses crypto.randomBytes; matching it here.
    const token = crypto.randomBytes(32).toString('hex');
    await query(
      `UPDATE clients SET activation_token = $1, activation_sent_at = NOW()
        WHERE id = $2`,
      [token, client.id]
    );
    await mailer.sendActivationEmail({
      email: client.email,
      token,
      name: client.fname || '',
      returnPath: returnPath || '/advertise/my-ads',
    });
    return res.json({ sent: true, hasEmail: true, alreadyActive: false });
  } catch (err) {
    console.error('[/api/internal/send-customer-activation]', err);
    return res.status(500).json({ error: err.message || 'send-customer-activation failed' });
  }
});

module.exports = router;
