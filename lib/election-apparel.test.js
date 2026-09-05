// lib/election-apparel.test.js
// Unit tests for the election apparel retail rule. Run with:
//
//   node --test lib/election-apparel.test.js
//
// These exist because of a bug that reached production: every colour and every
// size of the ATC1000 quoted $10, 6XL included, because a variant with no
// wholesale price loaded came back as the cheap-blank floor rather than as
// unsellable. Number(null) is 0, and 0 is finite and under five.

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { apparelRetail } = require('./election-apparel');

test('a wholesale price that is missing is not a price', () => {
  // The bug: all of these are Number()-ed to 0, which is finite and under $5,
  // so every one of them used to come back as the $10 floor.
  for (const missing of [null, undefined, '', 0, '0', '0.00']) {
    assert.equal(apparelRetail(missing), null, `${JSON.stringify(missing)} should not price`);
  }
});

test('a cheap blank still gets the $10 floor', () => {
  assert.equal(apparelRetail(3.20), 10);
  assert.equal(apparelRetail(4.99), 10);
});

test('anything else is doubled', () => {
  assert.equal(apparelRetail(5), 10);
  assert.equal(apparelRetail(6.10), 12.20);
  assert.equal(apparelRetail(22.50), 45);
});

test('nonsense does not price', () => {
  assert.equal(apparelRetail('abc'), null);
  assert.equal(apparelRetail(-4), null);
});
