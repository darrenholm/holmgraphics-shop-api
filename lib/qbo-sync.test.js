// lib/qbo-sync.test.js
//
// Run with:
//   node --test lib/qbo-sync.test.js
//
// Targeted at the small pure helpers in qbo-sync. The HTTP-touching
// helpers (qbGet/qbPost, ensureQboCustomer, createSalesReceiptFromOrder)
// need a QB OAuth fixture to test end-to-end and are out of scope here.
// What we cover: the normalisation logic that decides whether two
// DisplayName strings refer to the same QB customer -- the load-bearing
// piece of the option (c) 6240 fallback in findCustomerPermissive.

'use strict';

const test   = require('node:test');
const assert = require('node:assert/strict');
const { _internals } = require('./qbo-sync');
const { stripCorpSuffix, normalizeForMatch } = _internals;

// ─── stripCorpSuffix ─────────────────────────────────────────────────────────

test('stripCorpSuffix: drops common suffixes regardless of casing', () => {
  assert.equal(stripCorpSuffix('Holm Graphics Inc'),  'Holm Graphics');
  assert.equal(stripCorpSuffix('Holm Graphics INC.'), 'Holm Graphics');
  assert.equal(stripCorpSuffix('Holm Graphics inc'),  'Holm Graphics');
  assert.equal(stripCorpSuffix('Holm Graphics LLC'),  'Holm Graphics');
  assert.equal(stripCorpSuffix('Holm Graphics Ltd.'), 'Holm Graphics');
  assert.equal(stripCorpSuffix('HOLM GRAPHICS CORPORATION'), 'HOLM GRAPHICS');
});

test('stripCorpSuffix: leaves names without a suffix alone', () => {
  assert.equal(stripCorpSuffix('Holm Graphics'), 'Holm Graphics');
  assert.equal(stripCorpSuffix('Acme Co.'),       'Acme'); // 'co' IS a suffix
  // But "Inco" alone (a real Canadian company) shouldn't be stripped to nothing.
  assert.equal(stripCorpSuffix('Inco'), 'Inco');
});

test('stripCorpSuffix: handles empty and null gracefully', () => {
  assert.equal(stripCorpSuffix(''),         '');
  assert.equal(stripCorpSuffix(null),       '');
  assert.equal(stripCorpSuffix(undefined),  '');
  assert.equal(stripCorpSuffix('   '),       '');
});

// ─── normalizeForMatch ──────────────────────────────────────────────────────

test('normalizeForMatch: case + suffix + whitespace canonicalisation', () => {
  // The whole point: these all collapse to the same normalised form.
  const expected = 'holm graphics';
  assert.equal(normalizeForMatch('Holm Graphics'),         expected);
  assert.equal(normalizeForMatch('HOLM GRAPHICS'),         expected);
  assert.equal(normalizeForMatch('HOLM GRAPHICS INC'),     expected);
  assert.equal(normalizeForMatch('Holm Graphics Inc.'),    expected);
  assert.equal(normalizeForMatch('  Holm  Graphics  '),    expected);
  assert.equal(normalizeForMatch('Holm Graphics, LLC'),    expected);
});

test('normalizeForMatch: preserves substantive differences', () => {
  // Different parent company names should NOT collapse together.
  assert.notEqual(normalizeForMatch('Holm Graphics'),  normalizeForMatch('Holm Industries'));
  assert.notEqual(normalizeForMatch('Acme Inc'),       normalizeForMatch('Acme Health Inc'));
});

test('normalizeForMatch: scenario from order #9566 (the real-world case)', () => {
  // Bug report: client.company was 'Holm Graphics' (no Inc), QB had
  // 'Holm Graphics Inc'. Exact match missed; create returned 6240.
  // The permissive fallback uses normalizeForMatch -- this test pins the
  // fix.
  assert.equal(
    normalizeForMatch('Holm Graphics'),
    normalizeForMatch('Holm Graphics Inc')
  );
  assert.equal(
    normalizeForMatch('Holm Graphics'),
    normalizeForMatch('HOLM GRAPHICS INC')
  );
});

test('normalizeForMatch: empty / nullish fallback', () => {
  assert.equal(normalizeForMatch(''),        '');
  assert.equal(normalizeForMatch(null),      '');
  assert.equal(normalizeForMatch(undefined), '');
});
