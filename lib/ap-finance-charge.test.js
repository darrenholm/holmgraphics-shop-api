// lib/ap-finance-charge.test.js
//
//   node --test lib/ap-finance-charge.test.js
//
// Fixtures are the real SanMar Canada statement dated 2026-08-31 (statement 9),
// the one that sent a reviewer to enter two charges by hand. postFinanceCharge-
// Bill itself needs DB and QBO, but the two parts that decide what happens —
// which rows to charge for, and what the Bill looks like — are pure.

'use strict';

const test   = require('node:test');
const assert = require('node:assert/strict');
const {
  selectFinanceCharges,
  buildFinanceChargeBill,
  financeChargeDocNumber,
} = require('./ap-finance-charge');

// Statement 9, as reconciled. Two rows differ, both by their own interest.
const SANMAR = [
  { line_no: 1, doc_number: '84144P', txn_date: '2026-07-06',
    amount_cents: -9327, our_amount_cents: -9327, finance_charge_cents: 0 },
  { line_no: 2, doc_number: '8954974', txn_date: '2026-07-06',
    amount_cents: 246168, our_amount_cents: 243043, finance_charge_cents: 3128 },
  { line_no: 3, doc_number: '8969364', txn_date: '2026-07-16',
    amount_cents: 34924, our_amount_cents: 34650, finance_charge_cents: 274 },
  { line_no: 4, doc_number: '8981197', txn_date: '2026-07-28',
    amount_cents: 68648, our_amount_cents: 68647, finance_charge_cents: 0 },
];

const STATEMENT = {
  id: 9, vendor_name: 'SanMar Canada', vendor_qbo_id: '1435',
  statement_date: '2026-08-31',
};

// ─── selectFinanceCharges ───────────────────────────────────────────────────

test('the two real SanMar charges are picked up, and nothing else is', () => {
  const { charges, skipped, totalCents } = selectFinanceCharges(SANMAR);
  assert.deepEqual(charges.map((c) => c.line.doc_number), ['8954974', '8969364']);
  assert.deepEqual(charges.map((c) => c.cents), [3128, 274]);
  assert.equal(totalCents, 3402, '$34.02 total');
  assert.equal(skipped.length, 0);
});

test('three cents of tax rounding does not disqualify a charge', () => {
  // 31.28 charge against a 31.25 gap — the case the reconciliation note calls
  // interest. If the note says it, this has to post it.
  const { charges } = selectFinanceCharges([SANMAR[1]]);
  assert.equal(charges.length, 1);
});

test('a charge that does not account for its row is skipped, with a reason', () => {
  // Row 8969364 exactly as it stood before the tax on it was corrected:
  // our books said 372.90 against a statement row of 349.24, and a $2.74
  // charge came nowhere near explaining the $23.66 gap.
  const { charges, skipped } = selectFinanceCharges([{
    line_no: 3, doc_number: '8969364', amount_cents: 34924,
    our_amount_cents: 37290, finance_charge_cents: 274,
  }]);
  assert.equal(charges.length, 0);
  assert.equal(skipped.length, 1);
  assert.ok(skipped[0].reason.includes('$2.74'), skipped[0].reason);
  assert.ok(skipped[0].reason.includes('$23.66'), skipped[0].reason);
});

test('a charge on an invoice we have not booked is skipped, not guessed at', () => {
  const { charges, skipped } = selectFinanceCharges([{
    line_no: 1, doc_number: '777', amount_cents: 10000,
    our_amount_cents: null, finance_charge_cents: 500,
  }]);
  assert.equal(charges.length, 0);
  assert.match(skipped[0].reason, /not in our books/);
});

test('rows with no charge are ignored entirely, not skipped', () => {
  const { charges, skipped } = selectFinanceCharges([SANMAR[0], SANMAR[3]]);
  assert.equal(charges.length, 0);
  assert.equal(skipped.length, 0, 'a row with no interest is not a skipped charge');
});

test('a statement with nothing to charge for totals zero', () => {
  assert.equal(selectFinanceCharges([]).totalCents, 0);
});

// ─── buildFinanceChargeBill ─────────────────────────────────────────────────

test('the bill carries one line per charged invoice, naming it', () => {
  const { charges } = selectFinanceCharges(SANMAR);
  const p = buildFinanceChargeBill({
    statement: STATEMENT, charges, accountId: '53', docNumber: 'FC-20260831',
  });
  assert.equal(p.Line.length, 2);
  assert.equal(p.Line[0].Amount, 31.28);
  assert.equal(p.Line[1].Amount, 2.74);
  assert.match(p.Line[0].Description, /8954974/);
  assert.deepEqual(p.Line[0].AccountBasedExpenseLineDetail.AccountRef, { value: '53' });
  assert.deepEqual(p.VendorRef, { value: '1435' });
  assert.equal(p.TxnDate, '2026-08-31');
});

// Interest is an exempt financial service. Coding it taxable would claim an
// input tax credit that does not exist — the same class of error as the 5%
// SanMar invoice booked at 13%.
test('tax: no tax code anywhere, and the treatment is stated outright', () => {
  const { charges } = selectFinanceCharges(SANMAR);
  const p = buildFinanceChargeBill({
    statement: STATEMENT, charges, accountId: '53', docNumber: 'FC-20260831',
  });
  assert.equal(p.GlobalTaxCalculation, 'NotApplicable');
  assert.equal(p.TxnTaxDetail, undefined);
  for (const l of p.Line) {
    assert.equal(l.AccountBasedExpenseLineDetail.TaxCodeRef, undefined);
  }
});

test('the bill refuses to build without a vendor, an account, or any charge', () => {
  const { charges } = selectFinanceCharges(SANMAR);
  const args = { statement: STATEMENT, charges, accountId: '53', docNumber: 'FC-1' };
  assert.throws(() => buildFinanceChargeBill({ ...args, statement: { ...STATEMENT, vendor_qbo_id: null } }),
    /vendor_qbo_id/);
  assert.throws(() => buildFinanceChargeBill({ ...args, accountId: null }), /account/);
  assert.throws(() => buildFinanceChargeBill({ ...args, charges: [] }), /no charges/);
});

// ─── financeChargeDocNumber ─────────────────────────────────────────────────

test('the doc number is stable, readable and unique per statement', () => {
  assert.equal(financeChargeDocNumber(STATEMENT), 'FC-20260831');
  // Same statement, called twice — the adopt-rather-than-duplicate path
  // depends on this never drifting.
  assert.equal(financeChargeDocNumber(STATEMENT), financeChargeDocNumber({ ...STATEMENT }));
  assert.equal(financeChargeDocNumber({ id: 12, statement_date: null }), 'FC-S12');
});
