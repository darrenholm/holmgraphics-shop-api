// lib/qbo-sync.js
//
// Higher-level QBO entity sync helpers. Owns the canonical implementations
// of the low-level HTTP wrappers (qbGet/qbPost) and the email sanitizer
// (cleanEmail). routes/quickbooks.js and lib/qb-payments.js both import
// from here so there's one source of truth.
//
// Public surface:
//   QB_BASE()                       — sandbox vs production base URL
//   qbGet(path), qbPost(path, body) — auth'd JSON helpers
//   cleanEmail(raw)                 — strip Outlook/legacy artefacts
//   findMiscItemId()                — cached lookup of the "Misc" Item
//   ensureQboCustomer(client)       — get-or-create, persists qb_customer_id
//   createSalesReceiptFromOrder(id) — main entry point used by routes/orders.js
//
// Idempotency:
//   • ensureQboCustomer() skips create if client.qb_customer_id is set.
//   • createSalesReceiptFromOrder() skips create if order.qbo_invoice_id
//     is set, returning the stored Id. Safe to re-run after a partial
//     failure.
//
// Error handling:
//   These functions THROW on failure. Callers in fire-and-forget contexts
//   (routes/orders.js after commit) wrap in `.catch()` so the customer's
//   response isn't impacted; admins can re-sync later by re-calling.

'use strict';

const { query, queryOne } = require('../db/connection');
const { activeTokens } = require('./qbo-tokens');

// ─── Endpoint base ────────────────────────────────────────────────────────────
function QB_BASE() {
  return process.env.NODE_ENV === 'production'
    ? 'https://quickbooks.api.intuit.com'
    : 'https://sandbox-quickbooks.api.intuit.com';
}

// ─── HTTP wrappers ────────────────────────────────────────────────────────────
async function qbGet(path) {
  const t = await activeTokens();
  const res = await fetch(`${QB_BASE()}/v3/company/${t.realm_id}${path}`, {
    headers: {
      'Authorization': `Bearer ${t.access_token}`,
      'Accept':        'application/json',
    },
  });
  if (!res.ok) throw new Error(`QB API ${res.status}: ${await res.text()}`);
  return res.json();
}

async function qbPost(path, body) {
  const t = await activeTokens();
  const res = await fetch(`${QB_BASE()}/v3/company/${t.realm_id}${path}`, {
    method:  'POST',
    headers: {
      'Authorization': `Bearer ${t.access_token}`,
      'Accept':        'application/json',
      'Content-Type':  'application/json',
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text();
    // Parse QB's structured Fault payload so callers can branch on
    // .qbCode without re-parsing the message string. The wire format is
    // documented at developer.intuit.com (Fault.Error[]) — we attach the
    // first error's code + detail as properties on the thrown Error.
    let parsed = null;
    try { parsed = JSON.parse(text); } catch {}
    const fault = parsed?.Fault?.Error?.[0] || null;
    const err = new Error(`QB API ${res.status}: ${text}`);
    err.status   = res.status;
    err.qbCode   = fault?.code   || null;
    err.qbDetail = fault?.Detail || null;
    err.body     = parsed || text;
    throw err;
  }
  return res.json();
}

// ─── Email sanitizer ──────────────────────────────────────────────────────────
// QBO returns 400 ValidationFault on a malformed PrimaryEmailAddr but is
// happy if the field is omitted entirely. Drops `#mailto:...` artefacts
// from old Outlook pastes, surrounding `<...>`, and whitespace.
function cleanEmail(raw) {
  if (!raw) return '';
  let s = String(raw).trim();
  const hash = s.indexOf('#');
  if (hash >= 0) s = s.slice(0, hash).trim();
  s = s.replace(/^<|>$/g, '').trim();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s)) return '';
  return s;
}

// ─── Misc Item lookup (cached for the lifetime of the process) ───────────────
// QBO requires every SalesItemLineDetail to reference a real Item. The
// shop's online catalog isn't 1:1 mapped to QBO Items yet, so for now
// every line points at the company's "Misc" service item. Existing
// /invoice/project/:id route uses the same fallback (with '1' as the
// last resort if the Misc lookup itself fails).
let _miscItemId = null;
async function findMiscItemId() {
  if (_miscItemId) return _miscItemId;
  try {
    const data = await qbGet(
      `/query?query=${encodeURIComponent(`SELECT * FROM Item WHERE Name = 'Misc' MAXRESULTS 1`)}`
    );
    _miscItemId = data?.QueryResponse?.Item?.[0]?.Id || '1';
  } catch {
    _miscItemId = '1';
  }
  return _miscItemId;
}

// ─── Customer lookup / create primitives ────────────────────────────────────
// Three layers, each callable on its own:
//   findCustomerExact()      — current behaviour: WHERE DisplayName = '<X>'
//   findCustomerPermissive() — fallback that survives capitalisation /
//                              trailing-suffix differences (Inc vs no Inc,
//                              "Holm Graphics" vs "HOLM GRAPHICS INC", etc.)
//   findOrCreateQboCustomer  — try exact → try create → on 6240 (Duplicate
//                              Name Exists), try permissive search to find
//                              the colliding existing customer.
//
// Order #9566 hit exactly the "create returned 6240" path: client.company
// was 'Holm Graphics' (no Inc), QB had 'Holm Graphics Inc'; exact match
// missed, create raised 6240, the error bubbled to fire-and-forget and
// the SalesReceipt was never written. The permissive fallback below
// catches that case and returns the existing customer's Id.

// Escape a value for inline use in a QBQL string literal.
function qbqlEscape(s) {
  return String(s ?? '').replace(/'/g, "\\'");
}

// Strip common trailing legal-entity suffixes so "Holm Graphics" matches
// "Holm Graphics Inc". Idempotent and case-insensitive. Requires at least
// one separator (whitespace or comma/period) before the suffix so words
// that happen to end in 'co' or 'inc' (e.g. "Inco") aren't truncated.
function stripCorpSuffix(name) {
  return String(name || '')
    .trim()
    .replace(/[\s,.]+(inc|incorporated|llc|ltd|limited|corp|corporation|co|company)\.?\s*$/i, '')
    .trim();
}

// Normalise for comparison: lowercase, collapse whitespace, drop suffixes.
function normalizeForMatch(s) {
  return stripCorpSuffix(String(s || ''))
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

async function findCustomerExact(displayName) {
  const data = await qbGet(
    `/query?query=${encodeURIComponent(
      `SELECT * FROM Customer WHERE DisplayName = '${qbqlEscape(displayName)}' MAXRESULTS 1`
    )}`
  );
  return data?.QueryResponse?.Customer?.[0] || null;
}

// Pull a chunk of customers whose DisplayName starts with our base name,
// then pick the first whose normalised name matches ours after stripping
// punctuation, casing, and trailing legal suffixes. QBQL doesn't support
// LOWER()/UPPER(), so we filter client-side.
async function findCustomerPermissive(displayName) {
  const target = normalizeForMatch(displayName);
  if (!target) return null;
  const stem = stripCorpSuffix(displayName).trim();
  if (!stem) return null;

  // LIKE matches both 'Holm Graphics' and 'Holm Graphics Inc' from a stem
  // of 'Holm Graphics'. Keep MAXRESULTS modest -- if there are more than
  // 20 candidates, the staff has bigger naming-hygiene issues.
  const data = await qbGet(
    `/query?query=${encodeURIComponent(
      `SELECT * FROM Customer WHERE DisplayName LIKE '${qbqlEscape(stem)}%' MAXRESULTS 20`
    )}`
  );
  const candidates = data?.QueryResponse?.Customer || [];
  for (const c of candidates) {
    if (normalizeForMatch(c.DisplayName) === target) return c;
  }
  // Last-resort: any candidate whose normalised name contains our target,
  // or vice versa. Catches "Holm Graphics" matching "Holm Graphics Inc"
  // even if the stem search above happens to have already stripped
  // both sides to the same string.
  for (const c of candidates) {
    const cn = normalizeForMatch(c.DisplayName);
    if (cn.includes(target) || target.includes(cn)) return c;
  }
  return null;
}

// Generic find-or-create. Used both by ensureQboCustomer (which then
// persists the Id back to clients.qb_customer_id) and by the staff
// /invoice/project/:id handler in routes/quickbooks.js (which doesn't
// always know which clients row maps to the inputs). Returns the
// resolved Customer object (with .Id).
async function findOrCreateQboCustomer({ displayName, email, fname, lname }) {
  if (!displayName) throw new Error('findOrCreateQboCustomer: displayName is required');

  // Step 1: exact match.
  const exact = await findCustomerExact(displayName);
  if (exact) return exact;

  // Step 2: try to create.
  try {
    const created = await qbPost('/customer', {
      DisplayName: displayName,
      ...(fname ? { GivenName:  fname } : {}),
      ...(lname ? { FamilyName: lname } : {}),
      ...(email ? { PrimaryEmailAddr: { Address: email } } : {}),
    });
    if (created?.Customer?.Id) return created.Customer;
  } catch (err) {
    // Step 3: 6240 means QB already has a customer with this (or a
    // close-enough) name -- fall through to permissive search.
    if (err.qbCode !== '6240') throw err;
    const found = await findCustomerPermissive(displayName);
    if (found) {
      console.log(
        `[qbo] resolved 6240 for "${displayName}" -> existing customer ${found.Id} ("${found.DisplayName}")`
      );
      return found;
    }
    // Couldn't find via permissive search either -- give the caller a
    // diagnostic that names what to do next, instead of just rethrowing
    // the raw 6240 body.
    throw new Error(
      `QB has a customer with name "${displayName}" (or close variant) but it isn't ` +
      `findable via DisplayName search -- needs manual reconciliation in QB. ` +
      `Original error: ${err.qbDetail || err.message}`
    );
  }
  throw new Error('QBO did not return a Customer Id');
}

// ─── ensureQboCustomer ────────────────────────────────────────────────────────
// Take a `clients` row. If qb_customer_id is set, return it. Otherwise
// resolve via findOrCreateQboCustomer and persist the resulting Id
// back to the local row so future orders skip the round-trip entirely.
//
// Optional `email` override — when the caller has a per-transaction
// email (e.g. orders.notification_email) that should win over the
// account-level clients.email for the QB Customer record. Used by
// createSalesReceiptFromOrder so the new customer's PrimaryEmailAddr
// reflects what they entered at checkout.
async function ensureQboCustomer(client, { email: emailOverride } = {}) {
  if (client.qb_customer_id) return client.qb_customer_id;

  const email = cleanEmail(emailOverride) || cleanEmail(client.email);
  const displayName =
    client.company ||
    [client.fname, client.lname].filter(Boolean).join(' ') ||
    email ||
    `Client #${client.id}`;

  const customer = await findOrCreateQboCustomer({
    displayName,
    email,
    fname: client.fname,
    lname: client.lname,
  });

  await query(`UPDATE clients SET qb_customer_id = $1 WHERE id = $2`, [customer.Id, client.id]);
  return customer.Id;
}

// ─── createSalesReceiptFromOrder ──────────────────────────────────────────────
// Build and POST a SalesReceipt for an online order paid via QB Payments.
// Persists the resulting SalesReceipt Id into orders.qbo_invoice_id (the
// column is named for invoices but used for any QBO sales doc — repurposing
// rather than adding a new column).
//
// Returns the QBO SalesReceipt Id on success, or the existing Id if the
// order was already synced.
async function createSalesReceiptFromOrder(orderId) {
  const order = await queryOne(`SELECT * FROM orders WHERE id = $1`, [orderId]);
  if (!order) throw new Error(`Order ${orderId} not found`);
  if (order.qbo_invoice_id) return order.qbo_invoice_id;  // already synced

  const client = await queryOne(`SELECT * FROM clients WHERE id = $1`, [order.client_id]);
  if (!client) throw new Error(`Client ${order.client_id} not found for order ${orderId}`);

  const items = await query(
    `SELECT * FROM order_items WHERE order_id = $1 ORDER BY id`,
    [orderId]
  );

  // Decoration costs live in a separate table — roll them up per
  // order_item so we can render them as one extra line each.
  const decorationRows = await query(
    `SELECT order_item_id,
            COALESCE(SUM(decoration_cost), 0) AS deco_cost,
            COALESCE(SUM(setup_fee), 0)       AS setup_fee
       FROM order_decorations
      WHERE order_id = $1
      GROUP BY order_item_id`,
    [orderId]
  );
  const decoByItem = new Map(
    decorationRows.map((d) => [
      d.order_item_id,
      { deco: Number(d.deco_cost), setup: Number(d.setup_fee) },
    ])
  );

  // Resolve the BillEmail / PrimaryEmailAddr priority once: per-order
  // override (what the customer typed at checkout) wins over the
  // account-level clients.email. Used both to create the QB Customer
  // (if the auto-sync mints one) and to set BillEmail on the receipt
  // itself.
  const email = cleanEmail(order.notification_email) || cleanEmail(client.email);

  // 1. Make sure the customer exists in QBO (auto-sync if not).
  const qbCustomerId = await ensureQboCustomer(client, { email });

  // 2. Resolve the fallback Item ref once.
  const miscItemId = await findMiscItemId();

  // 3. Build the line array. One line per order_item, plus an optional
  //    decoration roll-up line per item, plus shipping. All TaxCode '7'
  //    (HST Ontario, matching the existing /invoice route convention).
  const Line = [];
  for (const it of items) {
    const lineSubtotal = Number(it.line_subtotal);
    const desc = [
      it.product_name || it.style,
      it.color_name,
      it.size,
    ].filter(Boolean).join(' / ') + ` (qty ${it.quantity})`;

    Line.push({
      Amount:      lineSubtotal,
      DetailType:  'SalesItemLineDetail',
      Description: desc,
      SalesItemLineDetail: {
        ItemRef:    { value: miscItemId },
        UnitPrice:  Number(it.unit_price),
        Qty:        Number(it.quantity),
        TaxCodeRef: { value: '7' },
      },
    });

    const deco = decoByItem.get(it.id);
    if (deco && (deco.deco > 0 || deco.setup > 0)) {
      const decoTotal = deco.deco + deco.setup;
      Line.push({
        Amount:      decoTotal,
        DetailType:  'SalesItemLineDetail',
        Description: `Decoration & setup — ${it.product_name || it.style}`,
        SalesItemLineDetail: {
          ItemRef:    { value: miscItemId },
          UnitPrice:  decoTotal,
          Qty:        1,
          TaxCodeRef: { value: '7' },
        },
      });
    }
  }

  // Shipping as its own line (if any).
  const shipping = Number(order.shipping_total) || 0;
  if (shipping > 0) {
    const shipDesc = [order.shipping_carrier, order.shipping_service]
      .filter(Boolean).join(' ').trim() || 'Shipping';
    Line.push({
      Amount:      shipping,
      DetailType:  'SalesItemLineDetail',
      Description: `Shipping — ${shipDesc}`,
      SalesItemLineDetail: {
        ItemRef:    { value: miscItemId },
        UnitPrice:  shipping,
        Qty:        1,
        TaxCodeRef: { value: '7' },
      },
    });
  }

  // 4. Build the SalesReceipt payload.
  // TxnDate uses the actual paid_at timestamp so books match the charge date.
  const paidAt = order.paid_at instanceof Date
    ? order.paid_at
    : new Date(order.paid_at || Date.now());
  const txnDate = paidAt.toISOString().slice(0, 10);

  // Note: TotalTax is set to 0 to let QBO recalculate via per-line
  // TaxCodeRef. This matches the existing /invoice route pattern. If the
  // recalculated total differs slightly from what we charged the customer
  // (rounding edge cases), reconcile manually in QBO — the customer was
  // charged the exact amount we computed at checkout via QB Payments,
  // which is unaffected.
  const payload = {
    CustomerRef:   { value: qbCustomerId },
    DocNumber:     String(order.order_number),
    TxnDate:       txnDate,
    PrivateNote:
      `Holm Graphics online order #${order.order_number}` +
      (order.qb_payment_id ? ` — QB Payments charge ${order.qb_payment_id}` : ''),
    ...(order.qb_payment_id ? { PaymentRefNum: String(order.qb_payment_id).slice(0, 21) } : {}),
    Line,
    TxnTaxDetail: {
      TxnTaxCodeRef: { value: '7' },
      TotalTax:      0,
    },
    ...(email ? { BillEmail: { Address: email } } : {}),
  };

  // 5. POST the SalesReceipt and persist the returned Id.
  const result = await qbPost('/salesreceipt?minorversion=65', payload);
  const qboId = result?.SalesReceipt?.Id;
  if (!qboId) throw new Error('QBO did not return a SalesReceipt Id');

  await query(
    `UPDATE orders SET qbo_invoice_id = $1, updated_at = NOW() WHERE id = $2`,
    [qboId, orderId]
  );
  return qboId;
}

// ─── createInvoiceFromOrder ───────────────────────────────────────────────────
// Net-terms counterpart to createSalesReceiptFromOrder. Same line-item
// structure but POSTs an Invoice (not SalesReceipt) with DueDate from
// orders.due_date and EmailStatus='NeedToSend' so QBO emails the invoice
// to the customer automatically. No PaymentRefNum -- there's no charge
// to reference; payment lands later against this invoice.
//
// Idempotent: orders.qbo_invoice_id short-circuits a re-run.
async function createInvoiceFromOrder(orderId) {
  const order = await queryOne(`SELECT * FROM orders WHERE id = $1`, [orderId]);
  if (!order) throw new Error(`Order ${orderId} not found`);
  if (order.qbo_invoice_id) return order.qbo_invoice_id;
  if (order.payment_method !== 'invoice_pending') {
    throw new Error(
      `Order ${orderId} payment_method is "${order.payment_method}", expected "invoice_pending" for an Invoice. ` +
      `Use createSalesReceiptFromOrder for card-paid orders.`
    );
  }

  const client = await queryOne(`SELECT * FROM clients WHERE id = $1`, [order.client_id]);
  if (!client) throw new Error(`Client ${order.client_id} not found for order ${orderId}`);

  const items = await query(
    `SELECT * FROM order_items WHERE order_id = $1 ORDER BY id`,
    [orderId]
  );
  const decorationRows = await query(
    `SELECT order_item_id,
            COALESCE(SUM(decoration_cost), 0) AS deco_cost,
            COALESCE(SUM(setup_fee), 0)       AS setup_fee
       FROM order_decorations
      WHERE order_id = $1
      GROUP BY order_item_id`,
    [orderId]
  );
  const decoByItem = new Map(decorationRows.map((d) => [
    d.order_item_id,
    { deco: Number(d.deco_cost), setup: Number(d.setup_fee) },
  ]));

  // Notification email + customer resolve. Same priority chain as the
  // SalesReceipt path: order.notification_email > clients.email.
  const email = cleanEmail(order.notification_email) || cleanEmail(client.email);
  const qbCustomerId = await ensureQboCustomer(client, { email });
  const miscItemId   = await findMiscItemId();

  // Build Line[] -- same shape as the SalesReceipt path. Reusing the
  // pattern keeps both QBO docs visually identical so staff browsing
  // QB don't have to context-switch between the two layouts.
  const Line = [];
  for (const it of items) {
    const lineSubtotal = Number(it.line_subtotal);
    const desc = [it.product_name || it.style, it.color_name, it.size]
      .filter(Boolean).join(' / ') + ` (qty ${it.quantity})`;
    Line.push({
      Amount:      lineSubtotal,
      DetailType:  'SalesItemLineDetail',
      Description: desc,
      SalesItemLineDetail: {
        ItemRef:    { value: miscItemId },
        UnitPrice:  Number(it.unit_price),
        Qty:        Number(it.quantity),
        TaxCodeRef: { value: '7' },
      },
    });
    const deco = decoByItem.get(it.id);
    if (deco && (deco.deco > 0 || deco.setup > 0)) {
      const decoTotal = deco.deco + deco.setup;
      Line.push({
        Amount:      decoTotal,
        DetailType:  'SalesItemLineDetail',
        Description: `Decoration & setup — ${it.product_name || it.style}`,
        SalesItemLineDetail: {
          ItemRef:    { value: miscItemId },
          UnitPrice:  decoTotal,
          Qty:        1,
          TaxCodeRef: { value: '7' },
        },
      });
    }
  }
  const shipping = Number(order.shipping_total) || 0;
  if (shipping > 0) {
    const shipDesc = [order.shipping_carrier, order.shipping_service]
      .filter(Boolean).join(' ').trim() || 'Shipping';
    Line.push({
      Amount:      shipping,
      DetailType:  'SalesItemLineDetail',
      Description: `Shipping — ${shipDesc}`,
      SalesItemLineDetail: {
        ItemRef:    { value: miscItemId },
        UnitPrice:  shipping,
        Qty:        1,
        TaxCodeRef: { value: '7' },
      },
    });
  }

  // TxnDate = today (when the invoice was issued). DueDate = order.due_date
  // (set at order create time as today + payment_terms_days). Format both
  // as YYYY-MM-DD to match QBO's Date wire format.
  const txnDate = new Date().toISOString().slice(0, 10);
  const dueDate = order.due_date instanceof Date
    ? order.due_date.toISOString().slice(0, 10)
    : (typeof order.due_date === 'string' ? order.due_date.slice(0, 10) : null);

  const payload = {
    CustomerRef: { value: qbCustomerId },
    DocNumber:   String(order.order_number),
    TxnDate:     txnDate,
    ...(dueDate ? { DueDate: dueDate } : {}),
    PrivateNote: `Holm Graphics online order #${order.order_number} — Net-terms invoice`,
    Line,
    TxnTaxDetail: {
      TxnTaxCodeRef: { value: '7' },
      TotalTax:      0,
    },
    // BillEmail + EmailStatus='NeedToSend' tells QBO to email the invoice
    // to the customer automatically. Without EmailStatus, QBO stores the
    // invoice but doesn't send -- and our Net-terms customer wouldn't see
    // it without staff manually clicking Send in QB.
    ...(email
      ? { BillEmail: { Address: email }, EmailStatus: 'NeedToSend' }
      : {}),
  };

  const result = await qbPost('/invoice?minorversion=65', payload);
  const qboId = result?.Invoice?.Id;
  if (!qboId) throw new Error('QBO did not return an Invoice Id');

  await query(
    `UPDATE orders SET qbo_invoice_id = $1, updated_at = NOW() WHERE id = $2`,
    [qboId, orderId]
  );
  return qboId;
}

module.exports = {
  QB_BASE,
  qbGet,
  qbPost,
  cleanEmail,
  findMiscItemId,
  findCustomerExact,
  findCustomerPermissive,
  findOrCreateQboCustomer,
  ensureQboCustomer,
  createSalesReceiptFromOrder,
  createInvoiceFromOrder,
  // Exported only for unit testing the normalisation helpers.
  _internals: { stripCorpSuffix, normalizeForMatch },
};
