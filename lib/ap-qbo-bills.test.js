// lib/ap-qbo-bills.test.js
//
// Run with:
//   node --test lib/ap-qbo-bills.test.js
//
// Covers buildBillPayload, the pure half of the QBO posting path. The tax
// treatment is the part worth pinning down in a test: the terminal
// write-back already learned the hard way that letting QBO apply its own
// tax default under the tax-EXCLUSIVE rule silently adds 13% on top of an
// amount that already includes it. A bill posted that way looks fine in the
// UI and drifts from the supplier's statement by exactly the tax, every
// month, forever.

'use strict';

const test   = require('node:test');
const assert = require('node:assert/strict');
const { _internals } = require('./ap-qbo-bills');
const { buildBillPayload, centsToDollars } = _internals;

const doc = (over = {}) => ({
  vendor_qbo_id: '56',
  doc_number:    'INV-4821',
  txn_date:      '2026-08-15',
  due_date:      '2026-09-14',
  currency:      'CAD',
  subtotal_cents: 100000,
  tax_cents:       13000,
  total_cents:    113000,
  memo:           null,
  ...over,
});

const line = (over = {}) => ({
  line_no: 1, description: 'Gildan 5000 Black L',
  amount_cents: 100000, account_qbo_id: '63', tax_code: '7',
  ...over,
});

// ─── centsToDollars ──────────────────────────────────────────────────────

test('centsToDollars: integer cents become the dollars QBO expects', () => {
  assert.equal(centsToDollars(113000), 1130);
  assert.equal(centsToDollars(1),      0.01);
  assert.equal(centsToDollars(-4500), -45);
  assert.equal(centsToDollars(0),         0);
  assert.equal(centsToDollars(null),      0);
});

// ─── buildBillPayload ────────────────────────────────────────────────────

test('builds a well-formed AccountBasedExpense bill', () => {
  const p = buildBillPayload({ doc: doc(), lines: [line()], defaultAccountId: null, termId: '3' });

  assert.deepEqual(p.VendorRef, { value: '56' });
  assert.equal(p.DocNumber, 'INV-4821');
  assert.equal(p.TxnDate,   '2026-08-15');
  assert.equal(p.DueDate,   '2026-09-14');
  assert.deepEqual(p.SalesTermRef, { value: '3' });
  assert.deepEqual(p.CurrencyRef,  { value: 'CAD' });

  assert.equal(p.Line.length, 1);
  assert.equal(p.Line[0].DetailType, 'AccountBasedExpenseLineDetail');
  assert.equal(p.Line[0].Amount, 1000);
  assert.equal(p.Line[0].Description, 'Gildan 5000 Black L');
  assert.deepEqual(p.Line[0].AccountBasedExpenseLineDetail.AccountRef, { value: '63' });
  assert.deepEqual(p.Line[0].AccountBasedExpenseLineDetail.TaxCodeRef, { value: '7' });
});

// Both halves of the tax treatment must be present: the per-line code puts
// the input tax credit in the right box, the explicit total stops QBO
// recomputing a figure that differs from the supplier's.
test('tax: line carries the code AND the supplier total is pinned', () => {
  const p = buildBillPayload({ doc: doc(), lines: [line()], defaultAccountId: null });
  assert.deepEqual(p.Line[0].AccountBasedExpenseLineDetail.TaxCodeRef, { value: '7' });
  assert.deepEqual(p.TxnTaxDetail, { TotalTax: 130 });
});

test('tax: a zero-tax bill still pins the total, so QBO cannot add its own', () => {
  const p = buildBillPayload({
    doc: doc({ tax_cents: 0, total_cents: 100000 }),
    lines: [line({ tax_code: null })],
    defaultAccountId: null,
  });
  assert.deepEqual(p.TxnTaxDetail, { TotalTax: 0 });
  assert.equal(p.Line[0].AccountBasedExpenseLineDetail.TaxCodeRef, undefined);
});

// Null tax means "we could not read a tax amount", which is different from
// zero: pinning a total we never read would be inventing an accounting fact.
test('tax: an unread tax amount omits TxnTaxDetail rather than guessing zero', () => {
  const p = buildBillPayload({
    doc: doc({ tax_cents: null }),
    lines: [line()],
    defaultAccountId: null,
  });
  assert.equal(p.TxnTaxDetail, undefined);
});

test('uncoded lines fall back to the configured default account', () => {
  const p = buildBillPayload({
    doc: doc(),
    lines: [line({ account_qbo_id: null })],
    defaultAccountId: '99',
  });
  assert.deepEqual(p.Line[0].AccountBasedExpenseLineDetail.AccountRef, { value: '99' });
});

test('an uncoded line with no default is a clear error, not a silent bad post', () => {
  assert.throws(
    () => buildBillPayload({
      doc: doc(),
      lines: [line({ account_qbo_id: null })],
      defaultAccountId: null,
    }),
    /no expense account and no default is configured/
  );
});

test('refuses to build a bill with no vendor or no lines', () => {
  assert.throws(
    () => buildBillPayload({ doc: doc({ vendor_qbo_id: null }), lines: [line()] }),
    /vendor_qbo_id required/
  );
  assert.throws(
    () => buildBillPayload({ doc: doc(), lines: [] }),
    /at least one line required/
  );
});

test('multi-line bills carry every line at its own amount', () => {
  const p = buildBillPayload({
    doc: doc(),
    lines: [
      line({ line_no: 1, amount_cents: 81600, description: 'Shirts' }),
      line({ line_no: 2, amount_cents: 18400, description: 'Freight' }),
    ],
    defaultAccountId: null,
  });
  assert.equal(p.Line.length, 2);
  assert.equal(p.Line[0].Amount, 816);
  assert.equal(p.Line[1].Amount, 184);
});

// QBO rejects a DocNumber over 21 characters with a ValidationFault, which
// is a confusing way to learn that a supplier uses long reference numbers.
test('DocNumber is truncated to the field QBO actually accepts', () => {
  const p = buildBillPayload({
    doc: doc({ doc_number: 'INVOICE-2026-08-000000004821-REV-B' }),
    lines: [line()],
    defaultAccountId: null,
  });
  assert.equal(p.DocNumber.length, 21);
  assert.equal(p.DocNumber, 'INVOICE-2026-08-00000');
});

test('optional header fields are omitted rather than sent null', () => {
  const p = buildBillPayload({
    doc: doc({ doc_number: null, txn_date: null, due_date: null, memo: null }),
    lines: [line()],
    defaultAccountId: null,
  });
  assert.equal('DocNumber'   in p, false);
  assert.equal('TxnDate'     in p, false);
  assert.equal('DueDate'     in p, false);
  assert.equal('PrivateNote' in p, false);
  assert.equal('SalesTermRef' in p, false);
});

// A credit note is a Bill with negative lines; the payload shape is the
// same, which is why postBillForDocument accepts both kinds.
test('credit notes build as negative-amount lines', () => {
  const p = buildBillPayload({
    doc: doc({ total_cents: -4500, tax_cents: -518, subtotal_cents: -3982 }),
    lines: [line({ amount_cents: -3982 })],
    defaultAccountId: null,
  });
  assert.equal(p.Line[0].Amount, -39.82);
  assert.deepEqual(p.TxnTaxDetail, { TotalTax: -5.18 });
});
