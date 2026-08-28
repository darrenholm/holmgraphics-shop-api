// lib/job-completion.test.js
//
// Run with:
//   node --test lib/job-completion.test.js
//
// Covers the arithmetic that decides whether a counter payment closes a job.
// This is the part worth pinning: too loose and a deposit closes a job the
// shop hasn't started, dropping it off the active board and stopping anyone
// chasing the balance; too tight and a job paid in full sits in Billing
// forever.
//
// The database side (completeIfFullyPaid) needs a live schema and is exercised
// by the staged testing plan in TERMINAL_POS.md.

'use strict';

const test   = require('node:test');
const assert = require('node:assert/strict');
const { isFullyPaid, STATUS_COMPLETE, _internals } = require('./job-completion');
const { HST, TOLERANCE_CENTS } = _internals;

// Job priced ex-tax at $190.00 -> $214.70 charged at the counter.
const SUBTOTAL = 19_000;
const OWED     = Math.round(SUBTOTAL * (1 + HST));   // 21_470

test('the tax-inclusive total is what the counter actually charges', () => {
  assert.equal(OWED, 21_470);
});

test('paid in full closes the job', () => {
  assert.equal(isFullyPaid(SUBTOTAL, OWED), true);
});

test('overpayment closes the job', () => {
  assert.equal(isFullyPaid(SUBTOTAL, OWED + 5_000), true);
});

test('a deposit does NOT close the job', () => {
  // The case this whole rule exists for: $500 down on a $2,000 sign.
  assert.equal(isFullyPaid(200_000, 50_000), false);
  // And a near-miss is still a miss.
  assert.equal(isFullyPaid(SUBTOTAL, OWED - 1_000), false);
});

test('rounding slack absorbs a cent or two, but not real money', () => {
  assert.equal(isFullyPaid(SUBTOTAL, OWED - TOLERANCE_CENTS), true);
  assert.equal(isFullyPaid(SUBTOTAL, OWED - TOLERANCE_CENTS - 1), false);
  // A dollar short is short.
  assert.equal(isFullyPaid(SUBTOTAL, OWED - 100), false);
});

test('an unpriced job never auto-completes', () => {
  // No line items means there is nothing to measure the payment against —
  // completing on the strength of any payment at all would be a guess.
  assert.equal(isFullyPaid(0, 100_000), false);
  assert.equal(isFullyPaid(-1, 100_000), false);
  assert.equal(isFullyPaid(null, 100_000), false);
  assert.equal(isFullyPaid(undefined, 100_000), false);
});

test('zero paid never closes a job', () => {
  assert.equal(isFullyPaid(SUBTOTAL, 0), false);
});

test('a refund that pulls the net below the total re-opens the arithmetic', () => {
  // completeIfFullyPaid sums (amount_cents - amount_refunded_cents), so a
  // refunded sale stops satisfying the rule. It does not un-complete a job on
  // its own, but it must not report the job as settled either.
  assert.equal(isFullyPaid(SUBTOTAL, OWED - 21_470), false);
});

test('small jobs settle exactly', () => {
  for (const sub of [100, 500, 1_337, 9_999]) {
    const owed = Math.round(sub * (1 + HST));
    assert.equal(isFullyPaid(sub, owed), true, `full payment failed at ${sub}`);
    assert.equal(isFullyPaid(sub, owed - 50), false, `underpayment passed at ${sub}`);
  }
});

test('Complete is status 11', () => {
  // Hardcoded across the codebase; pinned here so a schema change is caught.
  assert.equal(STATUS_COMPLETE, 11);
});
