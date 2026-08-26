// lib/phone.test.js
//
// Run with:
//   node --test lib/phone.test.js
//
// The acceptance criterion these exist for: an external caller arriving as
// '15198891343' must match a client stored as '(519) 889-1343'.

'use strict';

const test   = require('node:test');
const assert = require('node:assert/strict');
const { toE164, formatForDisplay, isInternalExtension, isAnonymous } = require('./phone');

// ─── The one that matters ───────────────────────────────────────────────────

test('raw inbound caller ID and a punctuated stored number normalize equal', () => {
  assert.equal(toE164('15198891343'), toE164('(519) 889-1343'));
  assert.equal(toE164('15198891343'), '+15198891343');
});

// ─── Stored-number formats seen in the clients table ────────────────────────

test('every punctuation convention in the DB lands on the same E.164', () => {
  const want = '+15195073001';
  for (const stored of [
    '519-507-3001',
    '(519) 507-3001',
    '(519) 507 3001',
    '5195073001',
    '519.507.3001',
    '+1 519 507 3001',
    '1-519-507-3001',
    ' 519-507-3001 ',
  ]) {
    assert.equal(toE164(stored), want, `failed on ${JSON.stringify(stored)}`);
  }
});

test('an extension suffix is dropped, not treated as an error', () => {
  assert.equal(toE164('519-507-3001 ext 2'), '+15195073001');
  assert.equal(toE164('519-507-3001 x2'),    '+15195073001');
});

// ─── Junk must be rejected, not coerced ─────────────────────────────────────
// A half-parsed number is worse than no number: it pops the wrong customer.

test('junk returns null', () => {
  for (const junk of [null, undefined, '', '   ', 'N/A', 'n/a', 'same as above',
                      'call the shop', '0000000000', '1234567890', 'abcdefghij']) {
    assert.equal(toE164(junk), null, `should reject ${JSON.stringify(junk)}`);
  }
});

test('a 7-digit local number is rejected — no area code to guess', () => {
  assert.equal(toE164('507-3001'), null);
});

// ─── Internal extensions ────────────────────────────────────────────────────
// Extension-to-extension calls arrive as $remote='104'. Never a customer.

test('bare extensions are recognised and never become phone numbers', () => {
  for (const ext of ['101', '104', '1', '400200']) {
    assert.ok(isInternalExtension(ext), `${ext} should read as an extension`);
    assert.equal(toE164(ext), null);
  }
});

test('a full phone number is not an extension', () => {
  assert.equal(isInternalExtension('5195073001'), false);
  assert.equal(isInternalExtension('(519) 507-3001'), false);
});

// ─── Blocked / anonymous caller ID ──────────────────────────────────────────

test('withheld caller ID is detected in every shape carriers send', () => {
  for (const v of [null, undefined, '', '  ', 'Anonymous', 'unknown',
                   'PRIVATE', 'Restricted', 'unavailable', 'blocked']) {
    assert.ok(isAnonymous(v), `${JSON.stringify(v)} should read as anonymous`);
  }
});

test('an unsupported Action URL variable arrives as literal text, not a number', () => {
  // The firmware passes through any $variable it doesn't recognise. Treat it
  // as "unsupported", never as an empty value or a real caller.
  assert.ok(isAnonymous('$remote'));
  assert.ok(isAnonymous('$call_id'));
});

test('a real number is not anonymous', () => {
  assert.equal(isAnonymous('15198891343'), false);
});

// ─── Display ────────────────────────────────────────────────────────────────

test('display format is what a person would read aloud', () => {
  assert.equal(formatForDisplay('+15198891343'), '(519) 889-1343');
  assert.equal(formatForDisplay('15198891343'),  '(519) 889-1343');
});

test('display falls back to the raw string rather than rendering blank', () => {
  assert.equal(formatForDisplay('call the shop'), 'call the shop');
  assert.equal(formatForDisplay(''), '');
  assert.equal(formatForDisplay(null), '');
});
