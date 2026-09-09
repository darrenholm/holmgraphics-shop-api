// lib/qbo-line-amount.test.js
//
//   node --test lib/qbo-line-amount.test.js
//
// Pins the fix for QBO error 6070 on job #9979 (Election — Nicole
// Porter-Schneider): 48 lawn signs, total $451.50, display unit_price
// $9.41. 48 x 9.41 = 451.68, so QBO rejected the whole invoice.

'use strict';

const test   = require('node:test');
const assert = require('node:assert/strict');
const { qboLineAmounts } = require('./qbo-line-amount');
const { priceOrder }     = require('./election-catalogue');

// QBO's own check, as close as we can state it: the supplied Amount must
// equal UnitPrice * Qty once rounded to the cent.
function qboWouldAccept({ Amount, UnitPrice, Qty }) {
  return Math.abs(Amount - Math.round(UnitPrice * Qty * 100) / 100) < 1e-9;
}

test('job #9979: the line that threw 6070 now reconciles', () => {
  const line = qboLineAmounts({ amount: 451.50, unitPrice: 9.41, qty: 48 });
  assert.equal(line.Amount, 451.50, 'the customer still owes the same money');
  assert.equal(line.UnitPrice, 9.40625);
  assert.equal(line.Qty, 48);
  assert.ok(qboWouldAccept(line));
});

test('lines that were already consistent are left alone', () => {
  assert.deepEqual(
    qboLineAmounts({ amount: 399.00, unitPrice: 66.50, qty: 6 }),
    { Amount: 399.00, UnitPrice: 66.50, Qty: 6 },
  );
  assert.deepEqual(
    qboLineAmounts({ amount: 270.00, unitPrice: 22.50, qty: 12 }),
    { Amount: 270.00, UnitPrice: 22.50, Qty: 12 },
  );
});

test('the total wins when unit_price disagrees with it', () => {
  // A hand-typed job line where somebody edited the total and not the rate.
  const line = qboLineAmounts({ amount: 100, unitPrice: 999, qty: 4 });
  assert.equal(line.Amount, 100);
  assert.equal(line.UnitPrice, 25);
});

test('repeating decimals still land on the right cent', () => {
  for (const [amount, qty] of [[100, 3], [451.5, 48], [0.01, 7], [1000, 7], [19.99, 13]]) {
    const line = qboLineAmounts({ amount, unitPrice: 0, qty });
    assert.equal(line.Amount, amount, `${amount} / ${qty}`);
    assert.ok(qboWouldAccept(line), `${amount} / ${qty}`);
  }
});

test('credit lines keep their sign', () => {
  const line = qboLineAmounts({ amount: -45.50, unitPrice: -9.10, qty: 5 });
  assert.equal(line.Amount, -45.50);
  assert.equal(line.UnitPrice, -9.10);
  assert.ok(qboWouldAccept(line));
});

test('zero or missing qty bills as a single unit', () => {
  assert.deepEqual(qboLineAmounts({ amount: 75, unitPrice: 75, qty: 0 }),
    { Amount: 75, UnitPrice: 75, Qty: 1 });
  assert.deepEqual(qboLineAmounts({ amount: 75, unitPrice: 75 }),
    { Amount: 75, UnitPrice: 75, Qty: 1 });
});

test('a missing total falls back to unit x qty', () => {
  assert.deepEqual(qboLineAmounts({ unitPrice: 9.41, qty: 48 }),
    { Amount: 451.68, UnitPrice: 9.41, Qty: 48 });
});

test('every election-catalogue line survives QBO validation', () => {
  const { lines } = priceOrder({
    signs: [
      { cutKey: '32x48', sheetKey: '4mm-single', quantity: 6 },
      { cutKey: '12x16', sheetKey: '4mm-single', quantity: 48, stands: 48 },
      { cutKey: '16x24', sheetKey: '4mm-double', quantity: 12 },
      { cutKey: '12x12', sheetKey: '4mm-single', quantity: 7, stands: 5 },
      { cutKey: '48x96', sheetKey: '6mm-double', quantity: 11 },
      { cutKey: '24x32', sheetKey: '6mm-single', quantity: 100 },
    ],
    print: [
      { productKey: 'postcard-4.25x5.5', quantity: 1000, doubleSided: true },
      { productKey: 'doorhanger-8.5x3.5', quantity: 250 },
    ],
    decals: [{ widthIn: 4, heightIn: 6, quantity: 250 }],
    needsArtwork: true,
  });

  assert.ok(lines.length >= 4);
  for (const l of lines) {
    const out = qboLineAmounts({ amount: l.total, unitPrice: l.unit_price, qty: l.quantity });
    assert.equal(out.Amount, l.total, l.description);
    assert.ok(qboWouldAccept(out), l.description);
  }
});
