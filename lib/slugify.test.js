// lib/slugify.test.js
//
// Run with:
//   node --test lib/slugify.test.js
//
// Boundary-focused: each test pins one specific behaviour so a regression
// fingers the exact rule that broke.

'use strict';

const test   = require('node:test');
const assert = require('node:assert/strict');
const { slugify } = require('./slugify');

// ─── Basic shapes ───────────────────────────────────────────────────────────

test('basic word lowercased', () => {
  assert.equal(slugify('Headwear'), 'headwear');
});

test('multi-word with spaces', () => {
  assert.equal(slugify('Left chest'), 'left-chest');
});

test('multi-word with mixed punctuation', () => {
  assert.equal(slugify('Yoke / Upper back'), 'yoke-upper-back');
});

test('collapses runs of separators', () => {
  assert.equal(slugify('multi---hyphens'),    'multi-hyphens');
  assert.equal(slugify('multi   spaces'),     'multi-spaces');
  assert.equal(slugify('mixed _ - / sep'),    'mixed-sep');
});

test('trims leading and trailing separators', () => {
  assert.equal(slugify('  spaces  around  '), 'spaces-around');
  assert.equal(slugify('---wrapped---'),       'wrapped');
});

// ─── Unicode ───────────────────────────────────────────────────────────────

test('strips combining marks via NFKD (accents)', () => {
  assert.equal(slugify('Très joli'),   'tres-joli');
  assert.equal(slugify('Cliché café'), 'cliche-cafe');
});

test('non-Latin codepoints map to a single hyphen', () => {
  // Ideographic chars aren't in [a-z0-9] so the run becomes one hyphen.
  // Result: "test--" → trimmed → "test". Verifies step 4's trim.
  assert.equal(slugify('test 中文'), 'test');
});

// ─── Empty / fallback ───────────────────────────────────────────────────────

test('empty string returns fallback (default empty)', () => {
  assert.equal(slugify(''),         '');
  assert.equal(slugify('   '),      '');
});

test('null and undefined return fallback', () => {
  assert.equal(slugify(null),       '');
  assert.equal(slugify(undefined),  '');
});

test('punctuation-only returns fallback (default empty)', () => {
  assert.equal(slugify('!!!'),       '');
  assert.equal(slugify('---'),       '');
  assert.equal(slugify('   /// '),   '');
});

test('custom fallback is honoured for empties', () => {
  assert.equal(slugify('',     { fallback: 'unnamed' }), 'unnamed');
  assert.equal(slugify(null,   { fallback: 'unnamed' }), 'unnamed');
  assert.equal(slugify('!!!',  { fallback: 'unnamed' }), 'unnamed');
});

// ─── maxLen ────────────────────────────────────────────────────────────────

test('maxLen truncates the slug', () => {
  const long = 'a'.repeat(100);
  const s = slugify(long, { maxLen: 40 });
  assert.equal(s.length, 40);
});

test('maxLen never leaves a trailing hyphen', () => {
  // 'aa-bb-cc-dd' truncated at 6 chars naively would be 'aa-bb-' — must trim.
  const s = slugify('aa bb cc dd', { maxLen: 6 });
  assert.ok(!s.endsWith('-'), `expected no trailing hyphen, got "${s}"`);
});

test('maxLen returns fallback if truncation kills the whole slug', () => {
  // '-a-b' at maxLen=0 → '' → fallback
  assert.equal(slugify('a b c', { maxLen: 0, fallback: 'unnamed' }), 'unnamed');
});

// ─── Realistic call sites ──────────────────────────────────────────────────

test('print_locations.name samples slugify cleanly', () => {
  assert.equal(slugify('Left chest'),         'left-chest');
  assert.equal(slugify('Right chest'),        'right-chest');
  assert.equal(slugify('Full back'),          'full-back');
  assert.equal(slugify('Yoke / Upper back'),  'yoke-upper-back');
  assert.equal(slugify('Lower / pocket'),     'lower-pocket');
  assert.equal(slugify('Center chest'),       'center-chest');
});

test('designs.name samples truncate at 40 cleanly', () => {
  assert.equal(slugify('Front left chest logo', { maxLen: 40 }), 'front-left-chest-logo');
  assert.equal(
    slugify('Customer-supplied art with a very long descriptive name', { maxLen: 40 }).length <= 40,
    true,
  );
});
