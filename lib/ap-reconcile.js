// lib/ap-reconcile.js
// Diffs a supplier's month-end statement against what we actually booked.
//
// This is the reason the AP pipeline keeps its own copy of every bill.
// QuickBooks has no supplier-statement feature at all: it can tell you what
// you entered, but never that the supplier billed you for something you
// never received. The four findings that matter:
//
//   missing         — on the statement, nowhere in our books. Either the
//                     invoice never arrived, or it arrived and was never
//                     entered. Both are money we are about to pay blind.
//   unposted        — we have the invoice, it just hasn't reached QBO yet.
//                     Not a problem, only a to-do.
//   amount_mismatch — both sides have it, the amounts disagree.
//   extra           — in our books for this period, absent from the
//                     statement. Usually a double entry on our side.
//
// matchStatementLines() is pure and does the actual thinking, so the
// matching rules can be tested without a database or a QBO connection.

'use strict';

const { query, queryOne } = require('../db/connection');
const { listBillsForVendor } = require('./ap-qbo-bills');

// Suppliers do not print an invoice number the same way twice. The same
// document is "INV-0004821" on the invoice, "4821" on the statement, and
// "INV 4821" in the emailed reminder. Normalizing to the significant digits
// is what makes those three the same key.
//
// Trailing letters are kept — "4821A" and "4821B" are genuinely different
// documents on suppliers who suffix revisions.
function normalizeDocNumber(raw) {
  if (!raw && raw !== 0) return '';
  let s = String(raw).toUpperCase().replace(/[\s\-_/#.]/g, '');
  // Strip a leading document-type prefix, not letters that are part of the
  // number itself.
  s = s.replace(/^(?:INV|INVOICE|BILL|CM|CN|CREDIT|DOC|NO)+/, '');
  // Drop leading zeros, but never reduce the string to nothing.
  s = s.replace(/^0+(?=.)/, '');
  return s;
}

// Statements print credits as a negative, in a credit column, or with a CR
// suffix, and our own extraction may or may not have carried the sign. The
// only comparison that survives all three is on magnitude plus the line's
// declared kind.
function amountsAgree(a, b, toleranceCents = 1) {
  if (a === null || a === undefined || b === null || b === undefined) return false;
  return Math.abs(Math.abs(a) - Math.abs(b)) <= toleranceCents;
}

/**
 * Pure matcher.
 *
 * @param {object[]} statementLines - { line_no, doc_number, txn_date, amount_cents, kind }
 * @param {object[]} ourBills       - QBO bills: { Id, DocNumber, TxnDate, TotalAmt, Balance }
 * @param {object[]} ourDocuments   - ap_documents rows not yet in QBO:
 *                                    { id, doc_number, total_cents, posted_at }
 * @param {object}   opts           - { toleranceCents }
 * @returns {{ lines: object[], extras: object[], summary: object }}
 */
function matchStatementLines(statementLines, ourBills, ourDocuments, opts = {}) {
  const toleranceCents = opts.toleranceCents ?? 1;

  // Index both sides by normalized document number. Arrays, not single
  // values: a supplier who reuses an invoice number across years would
  // otherwise silently drop one, and losing a bill is the failure this
  // whole module exists to catch.
  const billsByNum = new Map();
  for (const b of ourBills || []) {
    const key = normalizeDocNumber(b.DocNumber);
    if (!key) continue;
    if (!billsByNum.has(key)) billsByNum.set(key, []);
    billsByNum.get(key).push(b);
  }

  const docsByNum = new Map();
  for (const d of ourDocuments || []) {
    const key = normalizeDocNumber(d.doc_number);
    if (!key) continue;
    if (!docsByNum.has(key)) docsByNum.set(key, []);
    docsByNum.get(key).push(d);
  }

  const consumedBillIds = new Set();
  const lines = [];

  for (const sl of statementLines || []) {
    const base = {
      line_no:             sl.line_no,
      doc_number:          sl.doc_number || null,
      txn_date:            sl.txn_date || null,
      amount_cents:        sl.amount_cents ?? null,
      kind:                sl.kind || 'other',
      match_status:        null,
      matched_document_id: null,
      matched_qbo_bill_id: null,
      our_amount_cents:    null,
      note:                null,
    };

    // Payments and balance-forward rows aren't documents we could have
    // entered, so they are not findings.
    if (base.kind === 'payment' || base.kind === 'other') {
      lines.push({ ...base, match_status: 'ignored' });
      continue;
    }

    const key = normalizeDocNumber(sl.doc_number);
    if (!key) {
      lines.push({
        ...base,
        match_status: 'missing',
        note: 'Statement line has no readable document number',
      });
      continue;
    }

    // Prefer a bill whose amount also agrees, so a reused number lands on
    // the right one instead of the first one indexed.
    const candidates = billsByNum.get(key) || [];
    const bill =
      candidates.find((b) => !consumedBillIds.has(b.Id) &&
        amountsAgree(sl.amount_cents, Math.round(Number(b.TotalAmt || 0) * 100), toleranceCents)) ||
      candidates.find((b) => !consumedBillIds.has(b.Id)) ||
      null;

    if (bill) {
      consumedBillIds.add(bill.Id);
      const ourCents = Math.round(Number(bill.TotalAmt || 0) * 100);
      const agree = amountsAgree(sl.amount_cents, ourCents, toleranceCents);
      const unpaid = Number(bill.Balance || 0) > 0;
      lines.push({
        ...base,
        match_status:        agree ? 'matched' : 'amount_mismatch',
        matched_qbo_bill_id: String(bill.Id),
        our_amount_cents:    ourCents,
        note: agree
          ? (unpaid ? 'Entered, still outstanding' : 'Entered and paid')
          : `Statement says ${(Math.abs(sl.amount_cents) / 100).toFixed(2)}, we booked ${(Math.abs(ourCents) / 100).toFixed(2)}`,
      });
      continue;
    }

    // Not in QBO — but we may hold the invoice, merely unposted.
    const held = (docsByNum.get(key) || []).find((d) => !d.posted_at);
    if (held) {
      lines.push({
        ...base,
        match_status:        'unposted',
        matched_document_id: held.id,
        our_amount_cents:    held.total_cents ?? null,
        note: 'Invoice received and extracted, not yet posted to QuickBooks',
      });
      continue;
    }

    lines.push({
      ...base,
      match_status: 'missing',
      note: 'On the statement, not in our books — invoice never received or never entered',
    });
  }

  // Bills we hold for this vendor and period that the statement never
  // mentions. A supplier omitting one is unremarkable; two of ours matching
  // one of theirs is a double entry.
  const statementKeys = new Set(
    (statementLines || [])
      .filter((sl) => sl.kind === 'invoice' || sl.kind === 'credit')
      .map((sl) => normalizeDocNumber(sl.doc_number))
      .filter(Boolean)
  );

  const extras = (ourBills || [])
    .filter((b) => {
      const key = normalizeDocNumber(b.DocNumber);
      return key && !statementKeys.has(key);
    })
    .map((b) => ({
      qbo_bill_id:  String(b.Id),
      doc_number:   b.DocNumber || null,
      txn_date:     b.TxnDate || null,
      amount_cents: Math.round(Number(b.TotalAmt || 0) * 100),
      note: 'In our books, not on this statement',
    }));

  const summary = { matched: 0, amount_mismatch: 0, missing: 0, unposted: 0, ignored: 0 };
  for (const l of lines) summary[l.match_status] = (summary[l.match_status] || 0) + 1;
  summary.extra = extras.length;

  // What the statement says we owe, counting only the documents it lists as
  // charges. Compared against the statement's own closing balance by the
  // caller — a difference there means we mis-read a line, before any
  // question of what we did or didn't enter.
  summary.statement_charges_cents = (statementLines || [])
    .filter((l) => l.kind === 'invoice' || l.kind === 'credit')
    .reduce((sum, l) => sum + (l.amount_cents || 0), 0);

  return { lines, extras, summary };
}

// ─── DB-backed runner ────────────────────────────────────────────────────

// Widens the window to the statement's own date range plus a month either
// side. A statement dated the 31st routinely lists an invoice dated the 1st
// of the following month, and a bill we entered a few days late still needs
// to be found.
function dateWindow(statementLines, statementDate) {
  const dates = (statementLines || [])
    .map((l) => l.txn_date)
    .filter(Boolean)
    .sort();

  const first = dates[0] || statementDate;
  const last  = dates[dates.length - 1] || statementDate;
  if (!first || !last) return { since: null, until: null };

  const shift = (iso, days) => {
    const d = new Date(`${iso}T00:00:00Z`);
    d.setUTCDate(d.getUTCDate() + days);
    return d.toISOString().slice(0, 10);
  };

  return { since: shift(first, -31), until: shift(last, 31) };
}

async function reconcileStatement(statementId) {
  const stmt = await queryOne(`SELECT * FROM ap_statements WHERE id = $1`, [statementId]);
  if (!stmt) throw new Error(`ap_statements ${statementId} not found`);
  if (!stmt.vendor_qbo_id) {
    throw new Error(`Statement ${statementId} has no QBO vendor assigned — assign one before reconciling`);
  }

  const statementLines = await query(
    `SELECT line_no, doc_number, txn_date, amount_cents, kind
       FROM ap_statement_lines
      WHERE statement_id = $1
      ORDER BY line_no`,
    [statementId]
  );
  if (statementLines.length === 0) {
    throw new Error(`Statement ${statementId} has no extracted lines`);
  }

  // txn_date arrives from pg as a Date; the matcher and the window helper
  // both work in plain YYYY-MM-DD strings.
  const normalized = statementLines.map((l) => ({
    ...l,
    txn_date: l.txn_date instanceof Date ? l.txn_date.toISOString().slice(0, 10) : l.txn_date,
  }));

  const stmtDate = stmt.statement_date instanceof Date
    ? stmt.statement_date.toISOString().slice(0, 10)
    : stmt.statement_date;

  const { since, until } = dateWindow(normalized, stmtDate);

  const ourBills = await listBillsForVendor({
    vendorQboId: stmt.vendor_qbo_id,
    since,
    until,
  });

  const ourDocuments = await query(
    `SELECT id, doc_number, total_cents, posted_at
       FROM ap_documents
      WHERE vendor_qbo_id = $1
        AND doc_kind IN ('invoice', 'credit_note')
        AND review_status <> 'rejected'`,
    [stmt.vendor_qbo_id]
  );

  const { lines, extras, summary } = matchStatementLines(normalized, ourBills, ourDocuments);

  // Flag a mis-read statement before blaming the books: if our own sum of
  // the listed charges doesn't reach the printed closing balance, at least
  // one line was extracted wrong.
  if (stmt.closing_balance_cents !== null && stmt.closing_balance_cents !== undefined) {
    summary.closing_balance_cents = stmt.closing_balance_cents;
    summary.closing_balance_agrees =
      Math.abs(summary.statement_charges_cents - stmt.closing_balance_cents) <= 1;
  }

  for (const l of lines) {
    await query(
      `UPDATE ap_statement_lines
          SET match_status = $1, matched_document_id = $2, matched_qbo_bill_id = $3,
              our_amount_cents = $4, note = $5
        WHERE statement_id = $6 AND line_no = $7`,
      [l.match_status, l.matched_document_id, l.matched_qbo_bill_id,
       l.our_amount_cents, l.note, statementId, l.line_no]
    );
  }

  const fullSummary = { ...summary, extras };
  await query(
    `UPDATE ap_statements SET reconciled_at = NOW(), summary = $1 WHERE id = $2`,
    [JSON.stringify(fullSummary), statementId]
  );

  return { statementId, lines, extras, summary: fullSummary, window: { since, until } };
}

module.exports = {
  reconcileStatement,
  matchStatementLines,
  normalizeDocNumber,
  amountsAgree,
  dateWindow,
};
