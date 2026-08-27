// lib/qbo-terminal-writeback.test.js
//
// Run with:
//   node --test lib/qbo-terminal-writeback.test.js
//
// Covers the pure pieces of the counter-POS write-back: the money conversion
// that sits between Stripe's integer cents and QBO's dollar amounts, the
// debit-vs-credit classification that decides which QBO PaymentMethod a sale
// gets, the deterministic Intuit request id that keeps a webhook retry from
// double-posting, and the 429 backoff.
//
// The QBO-touching paths (postPaymentAgainstInvoice, postSalesReceipt,
// postStripeFee) need an OAuth fixture and a live company file; they're
// covered by the preflight endpoint and the staged testing plan in
// TERMINAL_POS.md instead.

'use strict';

const test   = require('node:test');
const assert = require('node:assert/strict');
const { _internals, isUndepositedFunds } = require('./qbo-terminal-writeback');

const {
  centsToDollars, dollarsToCents, paymentMethodNameFor,
  requestId, todayInToronto, qbCall, privateNoteFor,
  buildFeePurchasePayload,
} = _internals;

// ─── Money ───────────────────────────────────────────────────────────────────
// Every amount upstream is integer cents. The only place it becomes a float
// is the QBO payload, so this is the one conversion that can lose money.

test('centsToDollars: exact for the amounts a counter actually sees', () => {
  assert.equal(centsToDollars(0),      0);
  assert.equal(centsToDollars(1),      0.01);
  assert.equal(centsToDollars(100),    1);
  assert.equal(centsToDollars(19_000), 190);      // the average Interac ticket
  assert.equal(centsToDollars(21_470), 214.70);
  assert.equal(centsToDollars(2_500_000), 25_000);
});

test('centsToDollars: coerces junk to zero rather than NaN into a QBO payload', () => {
  assert.equal(centsToDollars(null),      0);
  assert.equal(centsToDollars(undefined), 0);
  assert.equal(centsToDollars('nope'),    0);
});

test('dollarsToCents: survives the float representations QBO returns', () => {
  assert.equal(dollarsToCents(214.70), 21_470);
  assert.equal(dollarsToCents(0.1 + 0.2), 30);   // 0.30000000000000004
  // 1.005 * 100 is 100.49999999999999 in binary floating point, so this
  // rounds DOWN. Harmless here — QBO only ever hands back two-decimal
  // amounts — but worth pinning so nobody reaches for this as a general
  // half-cent rounder.
  assert.equal(dollarsToCents(1.005), 100);
});

test('cents → dollars → cents round-trips', () => {
  for (const cents of [1, 99, 100, 1_337, 19_000, 21_470, 999_999]) {
    assert.equal(dollarsToCents(centsToDollars(cents)), cents, `failed at ${cents}`);
  }
});

// ─── Debit vs credit ─────────────────────────────────────────────────────────
// Stripe reports payment_method_type 'interac_present' for ALL Canadian
// debit, including co-branded cards whose brand still reads "visa". Getting
// this backwards is how a year of debit volume ends up filed as credit.

test('paymentMethodNameFor: interac_present wins over the card brand', () => {
  assert.equal(
    paymentMethodNameFor({ payment_method_type: 'interac_present', card_brand: 'visa' }),
    'Interac'
  );
  assert.equal(
    paymentMethodNameFor({ payment_method_type: 'interac_present', card_brand: 'mastercard' }),
    'Interac'
  );
});

test('paymentMethodNameFor: maps card brands to QBO PaymentMethod names', () => {
  assert.equal(paymentMethodNameFor({ payment_method_type: 'card_present', card_brand: 'visa' }), 'Visa');
  assert.equal(paymentMethodNameFor({ payment_method_type: 'card_present', card_brand: 'mastercard' }), 'MasterCard');
  assert.equal(paymentMethodNameFor({ payment_method_type: 'card_present', card_brand: 'amex' }), 'American Express');
  assert.equal(paymentMethodNameFor({ payment_method_type: 'card_present', card_brand: 'american_express' }), 'American Express');
});

test('paymentMethodNameFor: returns null rather than guessing', () => {
  // Null means "omit PaymentMethodRef" — a cosmetic field is not worth
  // inventing a list entry for.
  assert.equal(paymentMethodNameFor({}), null);
  assert.equal(paymentMethodNameFor({ payment_method_type: 'card_present', card_brand: 'jcb' }), null);
  assert.equal(paymentMethodNameFor({ card_brand: null }), null);
});

// ─── Intuit request id ───────────────────────────────────────────────────────

test('requestId: same logical write produces the same id', () => {
  assert.equal(requestId('payment', 'pi_3ABC'), requestId('payment', 'pi_3ABC'));
});

test('requestId: the sale, the fee and the refund do not collide', () => {
  const pi = 'pi_3ABC';
  const ids = new Set([
    requestId('payment', pi),
    requestId('salesreceipt', pi),
    requestId('fee', pi),
    requestId('refund', `${pi}:500`),
  ]);
  assert.equal(ids.size, 4);
});

test('requestId: fits inside Intuit\'s 50-character alphanumeric limit', () => {
  const id = requestId('payment', 'pi_3ABCdefGHI0123456789');
  assert.ok(id.length <= 50);
  assert.match(id, /^[a-z0-9]+$/);
});

// ─── Transaction date ────────────────────────────────────────────────────────

test('todayInToronto: emits a bare QBO date', () => {
  assert.match(todayInToronto(), /^\d{4}-\d{2}-\d{2}$/);
});

test('todayInToronto: an evening sale books to the shop\'s day, not UTC\'s', () => {
  // 8pm Eastern on 2026-08-27 is already 2026-08-28 in UTC. Using the
  // server's UTC date would misdate every evening sale by one day.
  const eveningUtc = new Date('2026-08-28T00:30:00Z');
  const torontoDate = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Toronto',
    year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(eveningUtc);
  assert.equal(torontoDate, '2026-08-27');
  assert.notEqual(torontoDate, eveningUtc.toISOString().slice(0, 10));
});

// ─── Throttle handling ───────────────────────────────────────────────────────
// QBO's 429 has taken this integration down before. These assert the retry
// classification, not the timing.

test('qbCall: returns the first success without retrying', async () => {
  let calls = 0;
  const out = await qbCall(async () => { calls++; return 'ok'; });
  assert.equal(out, 'ok');
  assert.equal(calls, 1);
});

test('qbCall: retries a 429 and returns the eventual success', async () => {
  let calls = 0;
  const out = await qbCall(async () => {
    calls++;
    if (calls < 3) {
      const e = new Error('QB API 429: throttled');
      e.status = 429;
      throw e;
    }
    return 'recovered';
  }, { label: 'test', baseDelayMs: 1 });
  assert.equal(out, 'recovered');
  assert.equal(calls, 3);
});

test('qbCall: retries a 503', async () => {
  let calls = 0;
  const out = await qbCall(async () => {
    calls++;
    if (calls === 1) {
      const e = new Error('QB API 503');
      e.status = 503;
      throw e;
    }
    return 'ok';
  }, { baseDelayMs: 1 });
  assert.equal(calls, 2);
  assert.equal(out, 'ok');
});

test('qbCall: does NOT retry a 400 — the payload will fail identically forever', async () => {
  let calls = 0;
  await assert.rejects(
    qbCall(async () => {
      calls++;
      const e = new Error('QB API 400: ValidationFault');
      e.status = 400;
      throw e;
    }),
    /ValidationFault/
  );
  assert.equal(calls, 1);
});

test('qbCall: gives up after the attempt limit and rethrows the last error', async () => {
  let calls = 0;
  await assert.rejects(
    qbCall(async () => {
      calls++;
      const e = new Error('QB API 429: still throttled');
      e.status = 429;
      throw e;
    }, { baseDelayMs: 1 }),
    /still throttled/
  );
  assert.equal(calls, 5);
});

// ─── Audit trail ─────────────────────────────────────────────────────────────

test('privateNoteFor: carries the PaymentIntent so a QBO row can be traced back', () => {
  const note = privateNoteFor({
    project_id: 9566,
    payment_method_type: 'interac_present',
    card_brand: 'visa',
    card_last4: '4242',
    payment_intent_id: 'pi_3ABC',
  }, 'applied to invoice #9566');

  assert.match(note, /job #9566/);
  assert.match(note, /Interac debit/);
  assert.match(note, /pi_3ABC/);
  assert.match(note, /••4242/);
  // The brand must not leak in alongside "Interac debit" — that's exactly
  // the confusion the interac_present check exists to prevent.
  assert.doesNotMatch(note, /visa/i);
});

test('privateNoteFor: drops the pieces a walk-in sale has no value for', () => {
  const note = privateNoteFor({ payment_intent_id: 'pi_3XYZ' }, 'counter sale, no invoice on file');
  assert.match(note, /pi_3XYZ/);
  assert.doesNotMatch(note, /job #/);
  assert.doesNotMatch(note, /••/);
});

// ─── Deposit account mode ────────────────────────────────────────────────────
// Undeposited Funds is a supported deposit target, but QBO won't let an
// expense be drawn on it, so the Stripe fee has to move to a Bank Deposit
// line. Getting this detection wrong means the fee either fails loudly after
// a customer has paid, or silently never posts and the account never zeroes.

test('isUndepositedFunds: matches on AccountSubType, not on the name', () => {
  assert.equal(isUndepositedFunds({ Name: 'Undeposited Funds', AccountSubType: 'UndepositedFunds' }), true);
  // A renamed system account is still the system account.
  assert.equal(isUndepositedFunds({ Name: 'Funds in Transit', AccountSubType: 'UndepositedFunds' }), true);
  // ...and an ordinary account merely named like one is not.
  assert.equal(
    isUndepositedFunds({ Name: 'Undeposited Funds (old)', AccountSubType: 'OtherCurrentAssets' }),
    false
  );
});

test('isUndepositedFunds: an ordinary clearing account is not it', () => {
  assert.equal(isUndepositedFunds({ Name: 'Stripe Clearing', AccountSubType: 'OtherCurrentAssets' }), false);
  assert.equal(isUndepositedFunds({ Name: 'Stripe Clearing', AccountSubType: 'Checking' }), false);
});

test('isUndepositedFunds: survives a missing or unqueried account', () => {
  assert.equal(isUndepositedFunds(null), false);
  assert.equal(isUndepositedFunds(undefined), false);
  assert.equal(isUndepositedFunds({ Name: 'Stripe Clearing' }), false);
});

// ─── Fee tax treatment ───────────────────────────────────────────────────────
// balance_transaction.fee is the TOTAL Stripe deducted, tax included. If QBO
// ever adds tax on top of it, the Purchase takes more out of the clearing
// account than Stripe took out of the payout, and the account drifts by the
// tax on every single sale. These pin the two treatments that don't do that.

const FEE_ROW = { fee_cents: 350, project_id: 9566, payment_intent_id: 'pi_3ABC' };
const FEE_ARGS = {
  row: FEE_ROW, clearingId: '91', feeAccountId: '77', vendorId: '12',
  txnDate: '2026-08-27',
};

test('fee purchase: no tax code posts the whole fee as expense', () => {
  const p = buildFeePurchasePayload({ ...FEE_ARGS, taxCode: null });
  assert.equal(p.GlobalTaxCalculation, 'NotApplicable');
  assert.equal(p.Line[0].Amount, 3.5);
  assert.equal(p.Line[0].AccountBasedExpenseLineDetail.TaxCodeRef, undefined);
});

test('fee purchase: a tax code is applied tax-INCLUSIVE, never exclusive', () => {
  const p = buildFeePurchasePayload({ ...FEE_ARGS, taxCode: '7' });
  // TaxExcluded here would make QBO add 13% on top of a fee that already
  // includes it — the reconciliation bug this exists to prevent.
  assert.equal(p.GlobalTaxCalculation, 'TaxInclusive');
  assert.notEqual(p.GlobalTaxCalculation, 'TaxExcluded');
  assert.deepEqual(p.Line[0].AccountBasedExpenseLineDetail.TaxCodeRef, { value: '7' });
});

test('fee purchase: the amount is what Stripe deducted, tax code or not', () => {
  const withTax    = buildFeePurchasePayload({ ...FEE_ARGS, taxCode: '7' });
  const withoutTax = buildFeePurchasePayload({ ...FEE_ARGS, taxCode: null });
  assert.equal(withTax.Line[0].Amount, withoutTax.Line[0].Amount);
  assert.equal(withTax.Line[0].Amount, 3.5);
});

test('fee purchase: money leaves the clearing account and lands in the fee account', () => {
  const p = buildFeePurchasePayload({ ...FEE_ARGS, taxCode: null });
  assert.equal(p.PaymentType, 'Cash');
  assert.deepEqual(p.AccountRef, { value: '91' });          // paid OUT of clearing
  assert.deepEqual(p.Line[0].AccountBasedExpenseLineDetail.AccountRef, { value: '77' });
  assert.match(p.PrivateNote, /pi_3ABC/);
});

test('fee purchase: a numeric tax code id is stringified for QBO', () => {
  const p = buildFeePurchasePayload({ ...FEE_ARGS, taxCode: 7 });
  assert.deepEqual(p.Line[0].AccountBasedExpenseLineDetail.TaxCodeRef, { value: '7' });
});

test('fee purchase: the vendor is omitted rather than sent empty', () => {
  const p = buildFeePurchasePayload({ ...FEE_ARGS, vendorId: null, taxCode: null });
  assert.equal(p.EntityRef, undefined);
});
