// lib/order-pricing-overrides.test.js
//
//   node --test lib/order-pricing-overrides.test.js
//
// The route handler in routes/orders.js POST /office can't be unit-tested
// without DB + QB Payments mocks we don't have, but the override-applier
// is a pure function and worth pinning. These tests catch the easy
// regressions: invalid-shape body, mutation of the input cart, missing
// item ids, the typical happy path.

'use strict';

const test   = require('node:test');
const assert = require('node:assert/strict');
const {
  validateUnitPriceOverrides,
  applyUnitPriceOverrides,
} = require('./order-pricing-overrides');

// ─── validateUnitPriceOverrides ─────────────────────────────────────────────

test('validate: null/undefined/empty all yield {}', () => {
  assert.deepEqual(validateUnitPriceOverrides(null),       {});
  assert.deepEqual(validateUnitPriceOverrides(undefined),  {});
  assert.deepEqual(validateUnitPriceOverrides({}),         {});
});

test('validate: rejects non-object inputs', () => {
  assert.throws(() => validateUnitPriceOverrides('nope'),  /must be an object/);
  assert.throws(() => validateUnitPriceOverrides(42),      /must be an object/);
  assert.throws(() => validateUnitPriceOverrides([1, 2]),  /must be an object/);
});

test('validate: rejects empty item ids', () => {
  assert.throws(() => validateUnitPriceOverrides({ '': 12 }), /empty item id/);
});

test('validate: rejects non-finite or negative prices', () => {
  assert.throws(() => validateUnitPriceOverrides({ a: 'abc' }),     /non-negative/);
  assert.throws(() => validateUnitPriceOverrides({ a: NaN }),       /non-negative/);
  assert.throws(() => validateUnitPriceOverrides({ a: Infinity }),  /non-negative/);
  assert.throws(() => validateUnitPriceOverrides({ a: -1 }),        /non-negative/);
});

test('validate: zero is allowed (free line items happen)', () => {
  assert.deepEqual(validateUnitPriceOverrides({ a: 0 }), { a: 0 });
});

test('validate: coerces numeric strings to numbers', () => {
  assert.deepEqual(validateUnitPriceOverrides({ a: '12.50' }), { a: 12.5 });
});

// ─── applyUnitPriceOverrides ────────────────────────────────────────────────

const sampleCart = () => ({
  items: [
    { id: 'i1', supplier: 'sanmar_ca', style: 'PC54', size: 'M', quantity: 5, unit_price: 10 },
    { id: 'i2', supplier: 'sanmar_ca', style: 'PC54', size: 'L', quantity: 3, unit_price: 10 },
    { id: 'i3', supplier: 'sanmar_ca', style: 'PC55', size: 'M', quantity: 1, unit_price: 25 },
  ],
  designs: [{ id: 'd1', name: 'logo' }],
});

test('apply: empty overrides returns cart untouched', () => {
  const cart = sampleCart();
  const out = applyUnitPriceOverrides(cart, {});
  assert.equal(out, cart);   // same reference -- no copy when no work to do
});

test('apply: overrides one item', () => {
  const cart = sampleCart();
  const out = applyUnitPriceOverrides(cart, { i2: 7.5 });
  assert.equal(out.items[0].unit_price, 10);   // unchanged
  assert.equal(out.items[1].unit_price, 7.5);  // overridden
  assert.equal(out.items[2].unit_price, 25);   // unchanged
});

test('apply: overrides multiple items independently', () => {
  const cart = sampleCart();
  const out = applyUnitPriceOverrides(cart, { i1: 0, i3: 999 });
  assert.equal(out.items[0].unit_price, 0);
  assert.equal(out.items[1].unit_price, 10);
  assert.equal(out.items[2].unit_price, 999);
});

test('apply: does NOT mutate the input cart', () => {
  const cart = sampleCart();
  applyUnitPriceOverrides(cart, { i1: 999 });
  assert.equal(cart.items[0].unit_price, 10);
});

test('apply: ignores override keys that don\'t match any cart item', () => {
  const cart = sampleCart();
  const out = applyUnitPriceOverrides(cart, { 'no-such-item': 0 });
  assert.deepEqual(
    out.items.map((it) => it.unit_price),
    cart.items.map((it) => it.unit_price)
  );
});

test('apply: handles a missing items array', () => {
  // Defensive: don't throw on a malformed cart -- the route's
  // validateCart() will catch that, this helper just no-ops.
  assert.equal(applyUnitPriceOverrides(null, { a: 1 }),       null);
  assert.equal(applyUnitPriceOverrides({}, { a: 1 }).items, undefined);
});
