// lib/ap-qbo-bills.js
// Posts a reviewed ap_documents row to QBO as a Bill and attaches the
// source PDF to it.
//
// Public surface:
//   resolveVendor({ name, norm })      — alias table → QBO Vendor
//   postBillForDocument(documentId)    — the main entry point
//   attachPdfToBill({...})             — Attachable upload, used by the above
//   listBillsForVendor({...})          — feeds statement reconciliation
//   buildBillPayload({...})            — pure; unit-tested
//
// Idempotency: postBillForDocument() returns the stored id without calling
// QBO if the row already has qbo_bill_id. Before creating, it also queries
// QBO for an existing Bill with the same DocNumber under the same vendor,
// which catches a bill entered by hand in QBO and the tail of a partial
// failure where the Bill was created but the DB update never landed.
//
// Tax: the payload sets TaxCodeRef per line AND passes the supplier's own
// tax total in TxnTaxDetail.TotalTax, then verifies what QBO actually
// booked. See the note on buildBillPayload for why both halves are needed.

'use strict';

const { query, queryOne } = require('../db/connection');
const { QB_BASE, qbGet, qbPost } = require('./qbo-sync');
const { activeTokens } = require('./qbo-tokens');
const { normalizeVendor } = require('./ap-extract');

// Ontario HST, same code the invoice and salesreceipt paths use.
const HST_TAX_CODE = process.env.QBO_AP_TAX_CODE || '7';

// Expense account for lines the reviewer left uncoded. A name, not an id,
// so it survives a QBO restore into a new realm.
const DEFAULT_ACCOUNT_NAME = () => process.env.QBO_AP_DEFAULT_ACCOUNT || '';

function qbqlEscape(s) {
  return String(s ?? '').replace(/'/g, "\\'");
}

function centsToDollars(cents) {
  return Math.round(Number(cents) || 0) / 100;
}

// ─── Throttle-aware call wrapper ─────────────────────────────────────────
// Same shape as the one in qbo-terminal-writeback.js: retries 429 and 5xx,
// never retries other 4xx because a bad payload fails identically forever.
const MAX_ATTEMPTS  = 5;
const BASE_DELAY_MS = 500;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function qbCall(fn, { label = 'qbo-ap' } = {}) {
  let lastErr;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      const status = err.status || 0;
      const retryable = status === 429 || status >= 500 || !status;
      if (!retryable || attempt === MAX_ATTEMPTS) break;
      const delay = BASE_DELAY_MS * 2 ** (attempt - 1);
      console.warn(`[ap-qbo] ${label} attempt ${attempt} failed (${status || 'network'}), retrying in ${delay}ms`);
      await sleep(delay);
    }
  }
  throw lastErr;
}

// Reference lookups are stable for the life of a process and are hit once
// per line on a multi-line bill, so they are cached exactly like the
// terminal write-back's.
const _refCache = new Map();
function clearRefCache() { _refCache.clear(); }

async function cachedLookup(key, fn) {
  if (_refCache.has(key)) return _refCache.get(key);
  const value = await fn();
  _refCache.set(key, value);
  return value;
}

async function qbQueryOne(sql, entity, label) {
  const data = await qbCall(
    () => qbGet(`/query?query=${encodeURIComponent(sql)}`),
    { label }
  );
  return data?.QueryResponse?.[entity]?.[0] || null;
}

// ─── Reference lookups ───────────────────────────────────────────────────

async function findVendorByName(name) {
  if (!name) return null;
  return cachedLookup(`vendor:${name}`, () => qbQueryOne(
    `SELECT Id, DisplayName FROM Vendor WHERE DisplayName = '${qbqlEscape(name)}' MAXRESULTS 1`,
    'Vendor', `findVendor(${name})`
  ));
}

async function findAccountByName(name) {
  if (!name) return null;
  return cachedLookup(`account:${name}`, () => qbQueryOne(
    `SELECT Id, Name FROM Account WHERE Name = '${qbqlEscape(name)}' MAXRESULTS 1`,
    'Account', `findAccount(${name})`
  ));
}

// Backs the vendor picker on the review screen. Not cached: the reviewer is
// searching precisely because the vendor list changed or the exact-name
// lookup already missed.
async function searchVendors(q, limit = 20) {
  const term = String(q || '').trim();
  if (!term) return [];
  const sql =
    `SELECT Id, DisplayName FROM Vendor ` +
    `WHERE DisplayName LIKE '%${qbqlEscape(term)}%' MAXRESULTS ${Number(limit) || 20}`;
  const data = await qbCall(
    () => qbGet(`/query?query=${encodeURIComponent(sql)}`),
    { label: `searchVendors(${term})` }
  );
  return (data?.QueryResponse?.Vendor || []).map((v) => ({ id: v.Id, name: v.DisplayName }));
}

// QBO calls vendor payment terms "Term". Matching by the printed text means
// "Net 30" on the invoice lands on the company's own Net 30 term; anything
// unrecognized is skipped and the explicit DueDate carries the due date on
// its own.
async function findTermByName(name) {
  if (!name) return null;
  return cachedLookup(`term:${name}`, () => qbQueryOne(
    `SELECT Id, Name FROM Term WHERE Name = '${qbqlEscape(name)}' MAXRESULTS 1`,
    'Term', `findTerm(${name})`
  ));
}

// Resolves a document's vendor to a QBO Vendor id, in three escalating
// steps: a learned alias, then an exact DisplayName hit, then nothing. It
// deliberately does NOT create vendors — a typo'd vendor name silently
// creating a near-duplicate in the vendor list is exactly the mess that
// makes a supplier statement impossible to reconcile later.
async function resolveVendor({ name, norm }) {
  const key = norm || normalizeVendor(name);
  if (!key) return null;

  const alias = await queryOne(
    `SELECT vendor_qbo_id, vendor_name FROM ap_vendor_aliases WHERE alias_norm = $1`,
    [key]
  );
  if (alias) {
    return { id: alias.vendor_qbo_id, name: alias.vendor_name, via: 'alias' };
  }

  const exact = await findVendorByName(name);
  if (exact) return { id: exact.Id, name: exact.DisplayName, via: 'exact' };

  return null;
}

// Teaches the alias table, so the next document from this supplier resolves
// without a prompt.
async function learnVendorAlias({ aliasNorm, vendorQboId, vendorName }) {
  if (!aliasNorm || !vendorQboId) return;
  await query(
    `INSERT INTO ap_vendor_aliases (alias_norm, vendor_qbo_id, vendor_name)
       VALUES ($1, $2, $3)
     ON CONFLICT (alias_norm) DO UPDATE SET
       vendor_qbo_id = EXCLUDED.vendor_qbo_id,
       vendor_name   = EXCLUDED.vendor_name`,
    [aliasNorm, vendorQboId, vendorName || '']
  );
}

// ─── Duplicate detection ─────────────────────────────────────────────────

async function findExistingBill({ vendorQboId, docNumber }) {
  if (!vendorQboId || !docNumber) return null;
  return qbQueryOne(
    `SELECT Id, DocNumber, TotalAmt, TxnDate FROM Bill ` +
    `WHERE DocNumber = '${qbqlEscape(docNumber)}' ` +
    `AND VendorRef = '${qbqlEscape(vendorQboId)}' MAXRESULTS 1`,
    'Bill', `findExistingBill(${docNumber})`
  );
}

// Every Bill for a vendor in a date window. The reconciler compares this
// against the statement, so it reads Balance as well as TotalAmt — a
// statement line that is present but unpaid is a different finding from one
// that is missing.
async function listBillsForVendor({ vendorQboId, since, until }) {
  if (!vendorQboId) return [];

  const clauses = [`VendorRef = '${qbqlEscape(vendorQboId)}'`];
  if (since) clauses.push(`TxnDate >= '${qbqlEscape(since)}'`);
  if (until) clauses.push(`TxnDate <= '${qbqlEscape(until)}'`);

  const out = [];
  // QBO returns at most 1000 rows per page and ignores anything beyond, so
  // page explicitly rather than trusting one request to cover a busy vendor.
  const PAGE = 500;
  for (let start = 1; ; start += PAGE) {
    const sql =
      `SELECT Id, DocNumber, TxnDate, DueDate, TotalAmt, Balance FROM Bill ` +
      `WHERE ${clauses.join(' AND ')} ` +
      `STARTPOSITION ${start} MAXRESULTS ${PAGE}`;
    const data = await qbCall(
      () => qbGet(`/query?query=${encodeURIComponent(sql)}`),
      { label: `listBills(${vendorQboId})` }
    );
    const batch = data?.QueryResponse?.Bill || [];
    out.push(...batch);
    if (batch.length < PAGE) break;
  }
  return out;
}

// ─── Payload ─────────────────────────────────────────────────────────────
// Pure so the tax treatment — the part most likely to be wrong against a
// real Canadian company file — can be asserted in tests without a network
// call.
//
// Two things set the tax, deliberately:
//   • TaxCodeRef on each line marks the line as taxable, which is what makes
//     the input tax credit land in the right box on the HST return.
//   • TxnTaxDetail.TotalTax pins the total to the supplier's own figure.
// Without the second, QBO recomputes 13% from its own rounding and the bill
// lands a cent or two off the invoice, which then shows up as an
// amount_mismatch on the statement every single month. postBillForDocument
// verifies what QBO actually booked rather than assuming this worked.
function buildBillPayload({ doc, lines, defaultAccountId, termId }) {
  if (!doc.vendor_qbo_id) throw new Error('buildBillPayload: vendor_qbo_id required');
  if (!lines || lines.length === 0) throw new Error('buildBillPayload: at least one line required');

  const Line = lines.map((l) => {
    const accountId = l.account_qbo_id || defaultAccountId;
    if (!accountId) {
      throw new Error(
        `Line ${l.line_no} has no expense account and no default is configured ` +
        `(set QBO_AP_DEFAULT_ACCOUNT to an account name in the chart of accounts)`
      );
    }
    const detail = { AccountRef: { value: String(accountId) } };
    if (l.tax_code) detail.TaxCodeRef = { value: String(l.tax_code) };

    return {
      DetailType: 'AccountBasedExpenseLineDetail',
      Amount: centsToDollars(l.amount_cents),
      ...(l.description ? { Description: String(l.description).slice(0, 4000) } : {}),
      AccountBasedExpenseLineDetail: detail,
    };
  });

  const payload = {
    VendorRef: { value: String(doc.vendor_qbo_id) },
    Line,
  };

  if (doc.doc_number) payload.DocNumber   = String(doc.doc_number).slice(0, 21);
  if (doc.txn_date)   payload.TxnDate     = doc.txn_date;
  if (doc.due_date)   payload.DueDate     = doc.due_date;
  if (termId)         payload.SalesTermRef = { value: String(termId) };
  if (doc.currency)   payload.CurrencyRef  = { value: doc.currency };
  if (doc.memo)       payload.PrivateNote  = String(doc.memo).slice(0, 4000);

  if (doc.tax_cents !== null && doc.tax_cents !== undefined) {
    payload.TxnTaxDetail = { TotalTax: centsToDollars(doc.tax_cents) };
  }

  return payload;
}

// ─── Attachment ──────────────────────────────────────────────────────────
// QBO's /upload endpoint is multipart, not JSON, so it can't go through
// qbPost. The metadata part must be named file_metadata_NN and the bytes
// file_content_NN with the SAME NN, or the upload succeeds and silently
// attaches nothing.
async function attachPdfToBill({ billId, filename, buffer, mimeType = 'application/pdf' }) {
  const t = await activeTokens();

  const metadata = {
    AttachableRef: [{ EntityRef: { type: 'Bill', value: String(billId) } }],
    FileName:    filename || `bill-${billId}.pdf`,
    ContentType: mimeType,
  };

  const form = new FormData();
  form.append(
    'file_metadata_01',
    new Blob([JSON.stringify(metadata)], { type: 'application/json' })
  );
  form.append(
    'file_content_01',
    new Blob([buffer], { type: mimeType }),
    metadata.FileName
  );

  const res = await fetch(`${QB_BASE()}/v3/company/${t.realm_id}/upload`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${t.access_token}`,
      Accept: 'application/json',
      // Content-Type is intentionally NOT set: fetch derives it from the
      // FormData along with the multipart boundary, and setting it by hand
      // omits the boundary and produces a 400 from Intuit.
    },
    body: form,
  });

  if (!res.ok) {
    const text = await res.text();
    const err = new Error(`QB upload ${res.status}: ${text}`);
    err.status = res.status;
    throw err;
  }

  const data = await res.json();
  const result = data?.AttachableResponse?.[0];
  if (result?.Fault) {
    throw new Error(`QB upload fault: ${JSON.stringify(result.Fault)}`);
  }
  return result?.Attachable?.Id || null;
}

// ─── Main entry point ────────────────────────────────────────────────────
async function postBillForDocument(documentId) {
  const doc = await queryOne(`SELECT * FROM ap_documents WHERE id = $1`, [documentId]);
  if (!doc) throw new Error(`ap_documents ${documentId} not found`);

  if (doc.qbo_bill_id) {
    return { billId: doc.qbo_bill_id, created: false, reason: 'already posted' };
  }
  if (doc.review_status !== 'approved') {
    throw new Error(`Document ${documentId} is ${doc.review_status}, not approved`);
  }
  if (doc.doc_kind !== 'invoice' && doc.doc_kind !== 'credit_note') {
    throw new Error(`Document ${documentId} is a ${doc.doc_kind} and cannot be posted as a Bill`);
  }
  if (!doc.vendor_qbo_id) {
    throw new Error(`Document ${documentId} has no QBO vendor assigned`);
  }

  const lines = await query(
    `SELECT * FROM ap_document_lines WHERE document_id = $1 ORDER BY line_no`,
    [documentId]
  );
  if (lines.length === 0) {
    throw new Error(`Document ${documentId} has no lines to post`);
  }

  // A bill entered by hand in QBO, or the tail of a partial failure here.
  // Adopting it is right in both cases: the accounting is already correct
  // and a second Bill would double the payable.
  const existing = await findExistingBill({
    vendorQboId: doc.vendor_qbo_id,
    docNumber:   doc.doc_number,
  });
  if (existing) {
    await query(
      `UPDATE ap_documents
          SET qbo_bill_id = $1, posted_at = NOW(), post_error = NULL, updated_at = NOW()
        WHERE id = $2`,
      [existing.Id, documentId]
    );
    return { billId: existing.Id, created: false, reason: 'matched existing bill in QBO' };
  }

  const defaultAccount = await findAccountByName(DEFAULT_ACCOUNT_NAME());
  const term           = await findTermByName(doc.terms);

  const payload = buildBillPayload({
    doc,
    lines,
    defaultAccountId: defaultAccount?.Id || null,
    termId:           term?.Id || null,
  });

  let bill;
  try {
    const data = await qbCall(() => qbPost('/bill?minorversion=75', payload), {
      label: `createBill(doc ${documentId})`,
    });
    bill = data?.Bill;
    if (!bill?.Id) throw new Error('QBO returned no Bill id');
  } catch (err) {
    await query(
      `UPDATE ap_documents SET post_error = $1, updated_at = NOW() WHERE id = $2`,
      [String(err.message).slice(0, 2000), documentId]
    );
    throw err;
  }

  // Verify rather than trust. If QBO's own total disagrees with the
  // supplier's, the tax treatment on this company file differs from what
  // buildBillPayload assumes — surface it on the row instead of letting the
  // difference turn up months later as a statement mismatch.
  let warning = null;
  const qboTotalCents = Math.round(Number(bill.TotalAmt || 0) * 100);
  if (doc.total_cents !== null && Math.abs(qboTotalCents - doc.total_cents) > 1) {
    warning =
      `QBO booked ${centsToDollars(qboTotalCents).toFixed(2)} but the document totals ` +
      `${centsToDollars(doc.total_cents).toFixed(2)} — check the tax code on this bill.`;
    console.warn(`[ap-qbo] doc ${documentId}: ${warning}`);
  }

  // Attach the source PDF so QBO holds the document, the one thing the
  // qbodocs path did well. A failure here must not fail the post: the Bill
  // is already real, and a missing attachment is re-runnable.
  let attachableId = null;
  if (doc.file_bytes) {
    try {
      attachableId = await attachPdfToBill({
        billId:   bill.Id,
        filename: doc.original_filename || `bill-${documentId}.pdf`,
        buffer:   doc.file_bytes,
        mimeType: doc.mime_type || 'application/pdf',
      });
    } catch (err) {
      const note = `Bill posted but PDF attach failed: ${err.message}`;
      warning = warning ? `${warning} ${note}` : note;
      console.warn(`[ap-qbo] doc ${documentId}: ${note}`);
    }
  }

  await query(
    `UPDATE ap_documents
        SET qbo_bill_id = $1, qbo_attachable_id = $2, posted_at = NOW(),
            post_error = $3, updated_at = NOW()
      WHERE id = $4`,
    [bill.Id, attachableId, warning, documentId]
  );

  return { billId: bill.Id, attachableId, created: true, warning };
}

module.exports = {
  resolveVendor,
  learnVendorAlias,
  postBillForDocument,
  attachPdfToBill,
  listBillsForVendor,
  findExistingBill,
  findVendorByName,
  searchVendors,
  findAccountByName,
  findTermByName,
  clearRefCache,
  HST_TAX_CODE,
  // Exported for unit tests.
  _internals: { buildBillPayload, centsToDollars, qbqlEscape, qbCall },
};
