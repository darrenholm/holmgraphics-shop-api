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
  if (!res.ok) throw new Error(`QB API ${res.status}: ${await res.text()}`);
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

// ─── ensureQboCustomer ────────────────────────────────────────────────────────
// Take a `clients` row. If qb_customer_id is set, return it. Otherwise
// look the customer up in QBO by DisplayName (so we don't dupe-create
// when an admin pre-imported them), create one if missing, persist the
// resulting Id back to the local row, and return it.
async function ensureQboCustomer(client) {
  if (client.qb_customer_id) return client.qb_customer_id;

  const email = cleanEmail(client.email);
  const displayName =
    client.company ||
    [client.fname, client.lname].filter(Boolean).join(' ') ||
    email ||
    `Client #${client.id}`;

  // Lookup-then-create.
  const searchData = await qbGet(
    `/query?query=${encodeURIComponent(
      `SELECT * FROM Customer WHERE DisplayName = '${displayName.replace(/'/g, "\\'")}' MAXRESULTS 1`
    )}`
  );
  let qbId = searchData?.QueryResponse?.Customer?.[0]?.Id;

  if (!qbId) {
    const created = await qbPost('/customer', {
      DisplayName: displayName,
      ...(client.fname ? { GivenName:  client.fname } : {}),
      ...(client.lname ? { FamilyName: client.lname } : {}),
      ...(email        ? { PrimaryEmailAddr: { Address: email } } : {}),
    });
    qbId = created?.Customer?.Id;
  }
  if (!qbId) throw new Error('QBO did not return a Customer Id');

  await query(`UPDATE clients SET qb_customer_id = $1 WHERE id = $2`, [qbId, client.id]);
  return qbId;
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

  // 1. Make sure the customer exists in QBO (auto-sync if not).
  const qbCustomerId = await ensureQboCustomer(client);

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

  const email = cleanEmail(client.email);

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

module.exports = {
  QB_BASE,
  qbGet,
  qbPost,
  cleanEmail,
  findMiscItemId,
  ensureQboCustomer,
  createSalesReceiptFromOrder,
};
