// lib/ap-reconcile.test.js
//
// Run with:
//   node --test lib/ap-reconcile.test.js
//
// The matcher is the whole value of the AP pipeline — it is the thing
// QuickBooks cannot do — so it is tested as a pure function against
// hand-built fixtures. The failure that matters is a FALSE 'matched': a
// statement line reported as reconciled when the invoice never reached our
// books means we pay for something we never received, and nothing
// downstream would catch it.

'use strict';

const test   = require('node:test');
const assert = require('node:assert/strict');
const {
  matchStatementLines,
  normalizeDocNumber,
  amountsAgree,
  dateWindow,
} = require('./ap-reconcile');

// ─── normalizeDocNumber ──────────────────────────────────────────────────

test('normalizeDocNumber: the same invoice printed three ways', () => {
  assert.equal(normalizeDocNumber('INV-0004821'), '4821');
  assert.equal(normalizeDocNumber('4821'),        '4821');
  assert.equal(normalizeDocNumber('INV 4821'),    '4821');
  assert.equal(normalizeDocNumber('inv#4821'),    '4821');
});

test('normalizeDocNumber: keeps revision suffixes, which are real', () => {
  assert.notEqual(normalizeDocNumber('4821A'), normalizeDocNumber('4821B'));
  assert.equal(normalizeDocNumber('4821A'), '4821A');
});

test('normalizeDocNumber: an all-zero number does not vanish', () => {
  assert.equal(normalizeDocNumber('0000'), '0');
  assert.equal(normalizeDocNumber(''),     '');
  assert.equal(normalizeDocNumber(null),   '');
});

// ─── amountsAgree ────────────────────────────────────────────────────────

test('amountsAgree: compares magnitude so credit sign conventions do not matter', () => {
  assert.equal(amountsAgree(4500, -4500), true);
  assert.equal(amountsAgree(-4500, 4500), true);
  assert.equal(amountsAgree(4500, 4501),  true);  // 1c rounding tolerance
  assert.equal(amountsAgree(4500, 4502),  false);
  assert.equal(amountsAgree(4500, null),  false);
  assert.equal(amountsAgree(null, null),  false);
});

// ─── matchStatementLines ─────────────────────────────────────────────────

const bill = (id, docNumber, dollars, balance = 0) => ({
  Id: String(id),
  DocNumber: docNumber,
  TxnDate: '2026-08-10',
  TotalAmt: dollars,
  Balance: balance,
});

const stmtLine = (line_no, doc_number, cents, kind = 'invoice') => ({
  line_no, doc_number, txn_date: '2026-08-10', amount_cents: cents, kind,
});

test('matched: statement line found in QBO with the same amount', () => {
  const { lines, summary } = matchStatementLines(
    [stmtLine(1, 'INV-4821', 113000)],
    [bill(10, '4821', 1130.00)],
    []
  );
  assert.equal(lines[0].match_status, 'matched');
  assert.equal(lines[0].matched_qbo_bill_id, '10');
  assert.equal(lines[0].our_amount_cents, 113000);
  assert.equal(summary.matched, 1);
  assert.equal(summary.missing, 0);
});

test('missing: on the statement, absent from our books — the finding that matters', () => {
  const { lines, summary } = matchStatementLines(
    [stmtLine(1, 'INV-4821', 113000), stmtLine(2, 'INV-4999', 22000)],
    [bill(10, '4821', 1130.00)],
    []
  );
  assert.equal(lines[0].match_status, 'matched');
  assert.equal(lines[1].match_status, 'missing');
  assert.equal(summary.missing, 1);
  assert.match(lines[1].note, /never received or never entered/);
});

test('amount_mismatch: both sides have it, the amounts disagree', () => {
  const { lines, summary } = matchStatementLines(
    [stmtLine(1, 'INV-4821', 113000)],
    [bill(10, '4821', 1030.00)],
    []
  );
  assert.equal(lines[0].match_status, 'amount_mismatch');
  assert.equal(lines[0].our_amount_cents, 103000);
  assert.equal(summary.amount_mismatch, 1);
  assert.match(lines[0].note, /1130\.00.*1030\.00/);
});

test('unposted: we hold the invoice, it just has not reached QBO', () => {
  const { lines, summary } = matchStatementLines(
    [stmtLine(1, 'INV-4821', 113000)],
    [],
    [{ id: 77, doc_number: 'INV-0004821', total_cents: 113000, posted_at: null }]
  );
  assert.equal(lines[0].match_status, 'unposted');
  assert.equal(lines[0].matched_document_id, 77);
  assert.equal(summary.unposted, 1);
  assert.equal(summary.missing, 0);
});

// A document row already marked posted but absent from the QBO result set
// is NOT 'unposted' — treating it as such would hide a bill that was
// deleted in QuickBooks after we posted it.
test('a posted document with no matching QBO bill still reads as missing', () => {
  const { lines } = matchStatementLines(
    [stmtLine(1, 'INV-4821', 113000)],
    [],
    [{ id: 77, doc_number: 'INV-4821', total_cents: 113000, posted_at: '2026-08-11' }]
  );
  assert.equal(lines[0].match_status, 'missing');
});

test('payments and balance-forward rows are ignored, not reported as missing', () => {
  const { lines, summary } = matchStatementLines(
    [
      stmtLine(1, '', 200000, 'payment'),
      stmtLine(2, '', 50000, 'other'),
      stmtLine(3, 'INV-4821', 113000),
    ],
    [bill(10, '4821', 1130.00)],
    []
  );
  assert.equal(lines[0].match_status, 'ignored');
  assert.equal(lines[1].match_status, 'ignored');
  assert.equal(lines[2].match_status, 'matched');
  assert.equal(summary.ignored, 2);
  assert.equal(summary.missing, 0);
});

test('credits match regardless of which side carries the minus sign', () => {
  const { lines } = matchStatementLines(
    [stmtLine(1, 'CM-118', -4500, 'credit')],
    [bill(20, '118', 45.00)],
    []
  );
  assert.equal(lines[0].match_status, 'matched');
});

test('a statement line with no readable number is a finding, not a silent skip', () => {
  const { lines, summary } = matchStatementLines(
    [stmtLine(1, '', 113000)],
    [bill(10, '4821', 1130.00)],
    []
  );
  assert.equal(lines[0].match_status, 'missing');
  assert.match(lines[0].note, /no readable document number/);
  assert.equal(summary.missing, 1);
});

test('extras: a bill in our books the statement never lists', () => {
  const { extras, summary } = matchStatementLines(
    [stmtLine(1, 'INV-4821', 113000)],
    [bill(10, '4821', 1130.00), bill(11, '4821-DUP', 1130.00)],
    []
  );
  assert.equal(extras.length, 1);
  assert.equal(extras[0].qbo_bill_id, '11');
  assert.equal(extras[0].amount_cents, 113000);
  assert.equal(summary.extra, 1);
});

// A supplier who reuses an invoice number across years must not have one of
// the two documents silently swallowed.
test('duplicate invoice numbers: each statement line consumes its own bill', () => {
  const { lines, summary } = matchStatementLines(
    [stmtLine(1, '4821', 113000), stmtLine(2, '4821', 50000)],
    [bill(10, '4821', 1130.00), bill(11, '4821', 500.00)],
    []
  );
  assert.equal(lines[0].match_status, 'matched');
  assert.equal(lines[1].match_status, 'matched');
  assert.notEqual(lines[0].matched_qbo_bill_id, lines[1].matched_qbo_bill_id);
  assert.equal(summary.matched, 2);
  assert.equal(summary.extra, 0);
});

// With two same-numbered bills, the one whose amount agrees must win even
// when it is indexed second — otherwise a correct pair reports as two
// mismatches.
test('duplicate numbers prefer the bill whose amount agrees', () => {
  const { lines } = matchStatementLines(
    [stmtLine(1, '4821', 50000)],
    [bill(10, '4821', 1130.00), bill(11, '4821', 500.00)],
    []
  );
  assert.equal(lines[0].match_status, 'matched');
  assert.equal(lines[0].matched_qbo_bill_id, '11');
});

test('summary totals the statement charges and excludes payments', () => {
  const { summary } = matchStatementLines(
    [
      stmtLine(1, '4821', 113000),
      stmtLine(2, 'CM-118', -4500, 'credit'),
      stmtLine(3, '', 200000, 'payment'),
    ],
    [],
    []
  );
  assert.equal(summary.statement_charges_cents, 113000 - 4500);
});

test('empty statement produces an empty, well-formed result', () => {
  const { lines, extras, summary } = matchStatementLines([], [], []);
  assert.deepEqual(lines, []);
  assert.deepEqual(extras, []);
  assert.equal(summary.missing, 0);
  assert.equal(summary.statement_charges_cents, 0);
});

// ─── dateWindow ──────────────────────────────────────────────────────────

test('dateWindow: widens a month either side of the listed documents', () => {
  const { since, until } = dateWindow(
    [{ txn_date: '2026-08-02' }, { txn_date: '2026-08-28' }],
    '2026-08-31'
  );
  assert.equal(since, '2026-07-02');
  assert.equal(until, '2026-09-28');
});

test('dateWindow: falls back to the statement date when no lines carry one', () => {
  const { since, until } = dateWindow([{ txn_date: null }], '2026-08-31');
  assert.equal(since, '2026-07-31');
  assert.equal(until, '2026-10-01');
});

test('dateWindow: no dates at all yields an open window rather than throwing', () => {
  assert.deepEqual(dateWindow([], null), { since: null, until: null });
});

// ─── Finance charges ─────────────────────────────────────────────────────
// SanMar adds interest to an overdue invoice and prints it on the statement
// row. The amounts then disagree for a reason that is not a mistake, and the
// note has to say which of the two it is.

test('a difference that is exactly the finance charge is named as one', () => {
  const line = { ...stmtLine(1, '8954974', 246168), finance_charge_cents: 3128 };
  const { lines } = matchStatementLines([line], [bill(1, '8954974', 2430.40)], []);

  assert.equal(lines[0].match_status, 'amount_mismatch');
  assert.match(lines[0].note, /difference is the 31\.28 finance charge/);
});

test('a difference the finance charge does not explain is not blamed on it', () => {
  const line = { ...stmtLine(1, '8969364', 34924), finance_charge_cents: 274 };
  const { lines } = matchStatementLines([line], [bill(1, '8969364', 372.90)], []);

  assert.equal(lines[0].match_status, 'amount_mismatch');
  assert.match(lines[0].note, /does not account for the difference/);
});

test('no finance charge on the row leaves the plain note alone', () => {
  const { lines } = matchStatementLines(
    [stmtLine(1, '8954974', 246168)], [bill(1, '8954974', 2430.40)], []
  );
  assert.equal(lines[0].note, 'Statement says 2461.68, we booked 2430.40');
});

// A credit entered in QuickBooks is a VendorCredit, which the reconciler is
// handed with a negated TotalAmt. Before that it reported every properly
// entered credit as missing.
test('a vendor credit entered in QBO matches the statement credit', () => {
  const credit = { ...bill(9, '84144P', -93.27), _isVendorCredit: true };
  const { lines, summary } = matchStatementLines(
    [stmtLine(1, '84144P', -9327, 'credit')], [credit], []
  );

  assert.equal(lines[0].match_status, 'matched');
  assert.equal(summary.missing, 0);
});

test('a few cents of rounding on top of the charge is still named as the charge', () => {
  // The real SanMar case: their invoice 2430.40, ours 2430.43, plus a 31.28
  // finance charge — a 31.25 gap against a 31.28 charge.
  const line = { ...stmtLine(1, '8954974', 246168), finance_charge_cents: 3128 };
  const { lines } = matchStatementLines([line], [bill(1, '8954974', 2430.43)], []);

  assert.equal(lines[0].match_status, 'amount_mismatch');
  assert.match(lines[0].note, /31\.28 of that is the finance charge/);
  assert.match(lines[0].note, /0\.03 of rounding/);
});

// ─── interest that has been entered settles its row ─────────────────────────
// A statement fully dealt with must read clean. Before this, the two SanMar
// rows whose only gap was interest stayed "amount differs" forever, on a
// statement where every dollar was accounted for — and a warning nobody can
// ever clear is a warning everybody learns to ignore.

const CHARGED = [
  { line_no: 1, doc_number: '8954974', txn_date: '2026-07-06', kind: 'invoice',
    amount_cents: 246168, finance_charge_cents: 3128 },
  { line_no: 2, doc_number: '8969364', txn_date: '2026-07-16', kind: 'invoice',
    amount_cents: 34924, finance_charge_cents: 274 },
];
const OUR_BILLS = [
  { Id: '32113', DocNumber: '8954974', TxnDate: '2026-07-06', TotalAmt: 2430.43, Balance: 2430.43 },
  { Id: '32114', DocNumber: '8969364', TxnDate: '2026-07-16', TotalAmt: 346.50, Balance: 346.50 },
];

test('interest still only printed on the statement stays a finding', () => {
  const { lines, summary } = matchStatementLines(CHARGED, OUR_BILLS, []);
  assert.equal(summary.amount_mismatch, 2);
  assert.equal(summary.matched ?? 0, 0);
  assert.match(lines[0].note, /finance charge/);
});

test('once the charges are on a bill, both rows read as matched', () => {
  const { lines, summary } = matchStatementLines(CHARGED, OUR_BILLS, [],
    { financeChargeDocNumber: 'FC-20260831' });
  assert.equal(summary.amount_mismatch ?? 0, 0, 'nothing left to chase');
  assert.equal(summary.matched, 2);
  for (const l of lines) {
    assert.equal(l.match_status, 'matched');
    assert.match(l.note, /interest, on bill FC-20260831/);
  }
  assert.ok(lines[0].note.includes('31.28'), lines[0].note);
  assert.ok(lines[1].note.includes('2.74'), lines[1].note);
});

test('a gap the interest does not explain is NOT settled by a posted bill', () => {
  // 8969364 as it stood before its tax was corrected: 372.90 booked against a
  // 349.24 statement row. A posted finance-charge bill must not launder that.
  const { lines, summary } = matchStatementLines(
    [CHARGED[1]],
    [{ Id: '32114', DocNumber: '8969364', TxnDate: '2026-07-16', TotalAmt: 372.90, Balance: 372.90 }],
    [], { financeChargeDocNumber: 'FC-20260831' });
  assert.equal(summary.amount_mismatch, 1);
  assert.equal(lines[0].match_status, 'amount_mismatch');
  assert.match(lines[0].note, /does not account for the difference/);
});

test('a row with no interest is unaffected either way', () => {
  const plain = [{ line_no: 1, doc_number: '8981197', txn_date: '2026-07-28',
                   kind: 'invoice', amount_cents: 68648, finance_charge_cents: 0 }];
  const bills = [{ Id: '32115', DocNumber: '8981197', TxnDate: '2026-07-28',
                   TotalAmt: 500.00, Balance: 500.00 }];
  const { summary } = matchStatementLines(plain, bills, [],
    { financeChargeDocNumber: 'FC-20260831' });
  assert.equal(summary.amount_mismatch, 1, 'a real difference still shows');
});
