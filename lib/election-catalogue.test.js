// lib/election-catalogue.test.js
// Unit tests for the election price list. Run with:
//
//   node --test lib/election-catalogue.test.js
//
// The figures asserted here are the shop's own, confirmed by Darren in
// September 2026. A change to one of these numbers should be a deliberate edit
// to both the rule and its test, not a surprise.

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  priceSigns,
  pricePrint,
  priceDecals,
  priceOrder,
  sheetDiscountPercent,
  ARTWORK_FEE,
} = require('./election-catalogue');

// ─── signs ───────────────────────────────────────────────────────────────────

test('one sheet of 12x12 is the sheet price, not a per-sign guess', () => {
  const line = priceSigns({ cutKey: '12x12', sheetKey: '4mm-single', quantity: 32 });
  assert.equal(line.quantity, 32);
  assert.equal(line.total, 210.00);
  assert.equal(line.item_type, 'CoroplastSign');
});

test('the sheet total is authoritative — per sign is derived and multiplies back', () => {
  const line = priceSigns({ cutKey: '12x12', sheetKey: '4mm-single', quantity: 32 });
  // This is the bug the portal shipped twice: rounding per sign then
  // multiplying leaves the line a few cents off the total beside it.
  assert.equal(line.unit_price, 6.56);
  assert.ok(Math.abs(line.unit_price * line.quantity - line.total) < 0.35);
});

test('a part sheet is charged as a whole one, and the extra signs come with it', () => {
  const line = priceSigns({ cutKey: '12x12', sheetKey: '4mm-single', quantity: 33 });
  assert.equal(line.sheets, 2);
  assert.equal(line.quantity, 64);
});

test('every extra sheet takes another 5% off, to a floor of 25%', () => {
  assert.equal(sheetDiscountPercent(1), 0);
  assert.equal(sheetDiscountPercent(2), 5);
  assert.equal(sheetDiscountPercent(4), 15);
  assert.equal(sheetDiscountPercent(6), 25);
  assert.equal(sheetDiscountPercent(20), 25);
});

test('two sheets of 6mm double-sided take 5% off the whole order', () => {
  const line = priceSigns({ cutKey: '16x24', sheetKey: '6mm-double', quantity: 24 });
  assert.equal(line.sheets, 2);
  assert.equal(line.total, 608.00); // 2 x 320 less 5%
});

test('wire stands are per sign, and only on cuts a stand can hold up', () => {
  const small = priceSigns({ cutKey: '12x16', sheetKey: '4mm-single', quantity: 24, stands: true });
  assert.equal(small.total, 210.00 + 24 * 2.10);

  // A 32x48 goes on posts. Asking for stands does not add a charge for
  // something the shop would not supply.
  const big = priceSigns({ cutKey: '32x48', sheetKey: '4mm-single', quantity: 2, stands: true });
  assert.equal(big.total, 210.00);
  assert.ok(big.mounting, 'a large sign carries a mounting note');
});

// ─── bought-in print ─────────────────────────────────────────────────────────

test('1000 hand-outs are the run price with freight already in it', () => {
  const line = pricePrint({ productKey: 'postcard-4.25x5.5', quantity: 1000 });
  assert.equal(line.quantity, 1000);
  assert.equal(line.total, 110.70); // (48.80 + 25) x 1.5
  assert.equal(line.item_type, 'Printing');
  assert.match(line.description, /Shipping included/);
});

test('the second side is 8% of the job, not a flat figure', () => {
  const single = pricePrint({ productKey: 'postcard-4.25x5.5', quantity: 1000 });
  const double = pricePrint({ productKey: 'postcard-4.25x5.5', quantity: 1000, doubleSided: true });
  assert.equal(double.total, 119.56);
  assert.ok(double.total > single.total);
});

test('a quantity between runs drops to the run below, never up', () => {
  const line = pricePrint({ productKey: 'doorhanger-8.5x3.5', quantity: 400 });
  assert.equal(line.quantity, 250);
});

test('250 door hangers', () => {
  const line = pricePrint({ productKey: 'doorhanger-8.5x3.5', quantity: 250 });
  assert.equal(line.total, 142.83); // (70.22 + 25) x 1.5
});

// ─── decals ──────────────────────────────────────────────────────────────────

test('ten car door decals cost the roll they consume', () => {
  const line = priceDecals({ widthIn: 20, heightIn: 12, quantity: 10 });
  // 2 across, 5 rows, 64" of roll => 24 sq ft at $8
  assert.equal(line.total, 192.00);
  assert.equal(line.item_type, 'Printing');
});

test('the nesting arithmetic stays out of what the candidate reads', () => {
  const line = priceDecals({ widthIn: 20, heightIn: 12, quantity: 10 });
  assert.equal(line.description, 'Vinyl decals 20" x 12"');
  assert.doesNotMatch(line.description, /across|rows|sq ft|roll/);
});

test('every line says which row it came from, so the form can price it in place', () => {
  const order = priceOrder({
    signs: [{ cutKey: '12x12', sheetKey: '4mm-single', quantity: 32 }],
    // The first decal is wider than the roll and cannot be priced. If lines
    // were matched to rows by position, everything after it would label the
    // wrong row.
    decals: [
      { widthIn: 60, heightIn: 12, quantity: 1 },
      { widthIn: 20, heightIn: 12, quantity: 10 },
    ],
    needsArtwork: true,
  });

  assert.deepEqual(order.lines.map((l) => l.source), [
    { kind: 'signs', index: 0 },
    { kind: 'decals', index: 1 },
    { kind: 'artwork', index: 0 },
  ]);
});

test('a small run is charged at the minimum', () => {
  const line = priceDecals({ widthIn: 2, heightIn: 2, quantity: 1 });
  assert.equal(line.total, 50.00);
  assert.equal(line.minimum_applied, true);
});

test('anything wider than the roll cannot be priced', () => {
  assert.equal(priceDecals({ widthIn: 60, heightIn: 12, quantity: 1 }), null);
});

// ─── the whole order ─────────────────────────────────────────────────────────

test('artwork is charged once for the job, not once per item', () => {
  const order = priceOrder({
    signs: [{ cutKey: '12x12', sheetKey: '4mm-single', quantity: 32 }],
    print: [{ productKey: 'postcard-4.25x5.5', quantity: 1000 }],
    decals: [{ widthIn: 20, heightIn: 12, quantity: 10 }],
    needsArtwork: true,
  });

  const artwork = order.lines.filter((l) => l.description.startsWith('Artwork'));
  assert.equal(artwork.length, 1);
  assert.equal(artwork[0].total, ARTWORK_FEE);
  assert.equal(order.subtotal, 210.00 + 110.70 + 192.00 + ARTWORK_FEE);
});

test('no artwork charge when the candidate sends print-ready files', () => {
  const order = priceOrder({
    signs: [{ cutKey: '12x12', sheetKey: '4mm-single', quantity: 32 }],
    needsArtwork: false,
  });
  assert.equal(order.lines.length, 1);
  assert.equal(order.subtotal, 210.00);
});

test('an empty order is not charged for artwork', () => {
  const order = priceOrder({ needsArtwork: true });
  assert.equal(order.lines.length, 0);
  assert.equal(order.subtotal, 0);
});

test('the subtotal is the lines added up, every time', () => {
  const order = priceOrder({
    signs: [
      { cutKey: '16x24', sheetKey: '6mm-double', quantity: 24 },
      { cutKey: '12x12', sheetKey: '4mm-single', quantity: 32, stands: true },
    ],
    print: [{ productKey: 'doorhanger-8.5x3.5', quantity: 250, doubleSided: true }],
    needsArtwork: true,
  });
  const summed = order.lines.reduce((s, l) => s + l.total, 0);
  assert.ok(Math.abs(summed - order.subtotal) < 0.005);
});
