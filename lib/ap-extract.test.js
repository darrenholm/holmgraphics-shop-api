// lib/ap-extract.test.js
//
// Run with:
//   node --test lib/ap-extract.test.js
//
// Covers the parsers that sit between the model's answer and the database.
// The API call itself is not tested here — it needs a real key and a real
// PDF — but everything that decides what a printed amount MEANS is, because
// a money parser that is quietly wrong produces bills that look plausible
// and reconcile against nothing.

'use strict';

const test   = require('node:test');
const assert = require('node:assert/strict');
const {
  parseMoneyToCents,
  parseDate,
  normalizeVendor,
  normalizeExtraction,
} = require('./ap-extract');

// ─── parseMoneyToCents ───────────────────────────────────────────────────

test('parseMoneyToCents: plain and formatted amounts', () => {
  assert.equal(parseMoneyToCents('1234.56'),    123456);
  assert.equal(parseMoneyToCents('1,234.56'),   123456);
  assert.equal(parseMoneyToCents('$1,234.56'),  123456);
  assert.equal(parseMoneyToCents('1 234.56'),   123456);
  assert.equal(parseMoneyToCents('0.00'),            0);
  assert.equal(parseMoneyToCents('45'),           4500);
  assert.equal(parseMoneyToCents('45.5'),         4550);
});

test('parseMoneyToCents: accounting negatives', () => {
  assert.equal(parseMoneyToCents('(45.00)'),    -4500);
  assert.equal(parseMoneyToCents('-45.00'),     -4500);
  assert.equal(parseMoneyToCents('45.00 CR'),   -4500);
  assert.equal(parseMoneyToCents('(1,234.56)'), -123456);
});

test('parseMoneyToCents: European decimal comma', () => {
  assert.equal(parseMoneyToCents('1.234,56'), 123456);
  assert.equal(parseMoneyToCents('1234,56'),  123456);
});

test('parseMoneyToCents: currency codes and symbols are stripped', () => {
  assert.equal(parseMoneyToCents('CAD 1,234.56'), 123456);
  assert.equal(parseMoneyToCents('1,234.56 USD'), 123456);
  assert.equal(parseMoneyToCents('€99.99'),         9999);
});

// null and 0 must stay distinct: "no such amount on the document" is a
// review prompt, "the amount is zero" is a fact.
test('parseMoneyToCents: absent amounts are null, not zero', () => {
  assert.equal(parseMoneyToCents(''),        null);
  assert.equal(parseMoneyToCents(null),      null);
  assert.equal(parseMoneyToCents(undefined), null);
  assert.equal(parseMoneyToCents('N/A'),     null);
  assert.equal(parseMoneyToCents('--'),      null);
  assert.equal(parseMoneyToCents('0.00'),       0);
  assert.equal(parseMoneyToCents(0),            0);
});

// The reason amounts cross the model boundary as strings at all.
test('parseMoneyToCents: no float drift on amounts that round badly', () => {
  assert.equal(parseMoneyToCents('1234.56'),  123456);
  assert.equal(parseMoneyToCents('0.07'),          7);
  assert.equal(parseMoneyToCents('8.29'),        829);
  assert.equal(parseMoneyToCents('1102.30'),  110230);
  // The naive version of this — Math.round(parseFloat(s) * 100) — is what
  // these guard against; each of the above is a value where the float
  // product lands just under the .5 boundary.
});

// ─── parseDate ───────────────────────────────────────────────────────────

test('parseDate: accepts ISO, rejects everything else', () => {
  assert.equal(parseDate('2026-09-04'), '2026-09-04');
  assert.equal(parseDate('2026-01-01'), '2026-01-01');
  assert.equal(parseDate('04/09/2026'), null);
  assert.equal(parseDate('Sep 4, 2026'), null);
  assert.equal(parseDate(''),            null);
  assert.equal(parseDate(null),          null);
});

test('parseDate: rejects impossible dates rather than rolling them over', () => {
  assert.equal(parseDate('2026-02-30'), null);
  assert.equal(parseDate('2026-13-01'), null);
  assert.equal(parseDate('2026-00-10'), null);
  assert.equal(parseDate('2024-02-29'), '2024-02-29'); // leap year is real
});

// ─── normalizeVendor ─────────────────────────────────────────────────────

test('normalizeVendor: same supplier spelled three ways collapses to one key', () => {
  const expected = 'sanmar canada';
  assert.equal(normalizeVendor('SANMAR CANADA ULC'), expected);
  assert.equal(normalizeVendor('SanMar Canada'),     expected);
  assert.equal(normalizeVendor('Sanmar Canada Ltd.'), expected);
});

test('normalizeVendor: punctuation and ampersands', () => {
  assert.equal(normalizeVendor('Smith & Sons, Inc.'), 'smith and sons');
  assert.equal(normalizeVendor('  Acme   Signs  '),   'acme signs');
  assert.equal(normalizeVendor(''),                   '');
  assert.equal(normalizeVendor(null),                 '');
});

// A suffix-looking word that is part of the name must survive.
test('normalizeVendor: only strips a suffix at the end', () => {
  assert.equal(normalizeVendor('Corporate Express'), 'corporate express');
});

// ─── normalizeExtraction ─────────────────────────────────────────────────

test('normalizeExtraction: maps a model answer onto column types', () => {
  const out = normalizeExtraction({
    doc_kind: 'invoice',
    confidence: 'high',
    vendor_name: 'SANMAR CANADA ULC',
    doc_number: 'INV-0004821',
    txn_date: '2026-08-15',
    due_date: '2026-09-14',
    terms: 'Net 30',
    currency: 'cad',
    subtotal: '1,000.00',
    tax: '130.00',
    total: '1,130.00',
    memo: '',
    lines: [
      { description: 'Gildan 5000 Black L', quantity: '24', unit_price: '4.15', amount: '99.60' },
      { description: 'Freight',             quantity: '',   unit_price: '',     amount: '18.40' },
    ],
    statement_lines: [],
    notes: '',
  });

  assert.equal(out.doc_kind,       'invoice');
  assert.equal(out.vendor_norm,    'sanmar canada');
  assert.equal(out.currency,       'CAD');
  assert.equal(out.subtotal_cents, 100000);
  assert.equal(out.tax_cents,       13000);
  assert.equal(out.total_cents,    113000);
  assert.equal(out.txn_date,   '2026-08-15');
  assert.equal(out.memo,             null);

  assert.equal(out.lines.length, 2);
  assert.equal(out.lines[0].line_no,      1);
  assert.equal(out.lines[0].quantity,    24);
  assert.equal(out.lines[0].unit_cents, 415);
  assert.equal(out.lines[0].amount_cents, 9960);
  // A line with no quantity or unit price still carries its amount.
  assert.equal(out.lines[1].quantity,   null);
  assert.equal(out.lines[1].unit_cents, null);
  assert.equal(out.lines[1].amount_cents, 1840);
});

// A line the model emitted with no readable amount cannot be posted to QBO
// and must not reach the payload as a zero.
test('normalizeExtraction: drops lines with no parsable amount', () => {
  const out = normalizeExtraction({
    doc_kind: 'invoice',
    lines: [
      { description: 'Real line',  quantity: '', unit_price: '', amount: '10.00' },
      { description: 'Garbage',    quantity: '', unit_price: '', amount: ''      },
    ],
    statement_lines: [],
  });
  assert.equal(out.lines.length, 1);
  assert.equal(out.lines[0].description, 'Real line');
});

test('normalizeExtraction: statement lines carry kind and parse dates', () => {
  const out = normalizeExtraction({
    doc_kind: 'statement',
    total: '5,420.18',
    lines: [],
    statement_lines: [
      { doc_number: '4821', date: '2026-08-02', amount: '1,130.00', kind: 'invoice' },
      { doc_number: '4899', date: '2026-08-19', amount: '(45.00)',  kind: 'credit'  },
      { doc_number: '',     date: '2026-08-31', amount: '2,000.00', kind: 'payment' },
    ],
  });

  assert.equal(out.doc_kind,    'statement');
  assert.equal(out.total_cents,  542018);
  assert.equal(out.statement_lines.length, 3);
  assert.equal(out.statement_lines[0].amount_cents, 113000);
  assert.equal(out.statement_lines[1].amount_cents,  -4500);
  assert.equal(out.statement_lines[1].kind,        'credit');
  assert.equal(out.statement_lines[2].kind,       'payment');
  assert.equal(out.statement_lines[0].txn_date, '2026-08-02');
});

// ─── criticalFieldsMissing ───────────────────────────────────────────────
// Decides both whether to pay for a second pass and whether the model's own
// confidence can be believed. A false negative here means a bill posts with
// no invoice number, which is unreconcilable against a statement forever.

const { criticalFieldsMissing } = require('./ap-extract');

const invoice = (over = {}) => ({
  doc_kind: 'invoice', doc_number: 'INV-1', txn_date: '2026-08-15',
  total_cents: 113000, ...over,
});

test('criticalFieldsMissing: a complete invoice is fine', () => {
  assert.equal(criticalFieldsMissing(invoice()), false);
});

test('criticalFieldsMissing: any of number, date or total missing trips it', () => {
  assert.equal(criticalFieldsMissing(invoice({ doc_number: null })),  true);
  assert.equal(criticalFieldsMissing(invoice({ doc_number: '' })),    true);
  assert.equal(criticalFieldsMissing(invoice({ txn_date: null })),    true);
  assert.equal(criticalFieldsMissing(invoice({ total_cents: null })), true);
});

// A zero-total invoice is a real thing (a fully discounted or replacement
// billing) and must not be mistaken for "we failed to read the total".
test('criticalFieldsMissing: a zero total is a value, not a gap', () => {
  assert.equal(criticalFieldsMissing(invoice({ total_cents: 0 })), false);
});

test('criticalFieldsMissing: credit notes are held to the same bar', () => {
  assert.equal(criticalFieldsMissing(invoice({ doc_kind: 'credit_note' })), false);
  assert.equal(criticalFieldsMissing(invoice({ doc_kind: 'credit_note', total_cents: null })), true);
});

// Statements have no invoice number or single total of their own, so the
// check must not fire on them and send every statement for a pointless and
// billable second read.
test('criticalFieldsMissing: never fires on statements or unknowns', () => {
  assert.equal(criticalFieldsMissing({ doc_kind: 'statement', doc_number: null, txn_date: null, total_cents: null }), false);
  assert.equal(criticalFieldsMissing({ doc_kind: 'unknown',   doc_number: null, txn_date: null, total_cents: null }), false);
  assert.equal(criticalFieldsMissing(null), false);
});
