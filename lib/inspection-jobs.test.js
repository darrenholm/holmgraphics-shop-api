// lib/inspection-jobs.test.js
//
// Run with:
//   node --test lib/inspection-jobs.test.js
//
// These cover the scheduler's clock arithmetic, which is the part that can
// be wrong for months without anyone noticing — a digest that fires at 07:00
// EST and 06:00 EDT still arrives every morning, so nothing looks broken.
//
// Railway runs the API in UTC. Every window in lib/inspection-jobs.js is
// expressed in shop-local time (America/Toronto), so the tests below pin
// instants in UTC and assert what the shop clock said at that moment.

'use strict';

const test   = require('node:test');
const assert = require('node:assert/strict');
const { _internals } = require('./inspection-jobs');
const { shopNow, isoWeekKey } = _internals;

// ─── The one that matters: DST ──────────────────────────────────────────────
// A fixed UTC offset would put the daily digest an hour out for eight months
// of the year. 12:00 UTC is 07:00 in winter (EST, −5) and 08:00 in summer
// (EDT, −4); the 07:00 window has to track that.

test('12:00 UTC is 07:00 in Toronto during standard time', () => {
  const t = shopNow(new Date('2026-01-15T12:00:00Z'));
  assert.equal(t.hour, 7);
  assert.equal(t.date, '2026-01-15');
});

test('12:00 UTC is 08:00 in Toronto during daylight time', () => {
  const t = shopNow(new Date('2026-07-15T12:00:00Z'));
  assert.equal(t.hour, 8);
});

test('11:00 UTC is 07:00 in Toronto during daylight time', () => {
  const t = shopNow(new Date('2026-07-15T11:00:00Z'));
  assert.equal(t.hour, 7);
});

test('the same UTC instant shifts an hour across the spring-forward date', () => {
  // Clocks jump 02:00 EST → 03:00 EDT on 2026-03-08. The day before, Toronto
  // is UTC−5; the day of and after, UTC−4. A scheduler using a hard-coded
  // offset would silently run an hour early for the next eight months.
  assert.equal(shopNow(new Date('2026-03-07T12:00:00Z')).hour, 7); // EST
  assert.equal(shopNow(new Date('2026-03-09T12:00:00Z')).hour, 8); // EDT
});

test('the 07:00 window is closed at 06:59 local and open at 07:00, either side of the change', () => {
  // Winter (UTC−5): 07:00 local is 12:00 UTC.
  assert.ok(shopNow(new Date('2026-01-15T11:59:00Z')).hour < 7);
  assert.ok(shopNow(new Date('2026-01-15T12:00:00Z')).hour >= 7);
  // Summer (UTC−4): 07:00 local is 11:00 UTC.
  assert.ok(shopNow(new Date('2026-07-15T10:59:00Z')).hour < 7);
  assert.ok(shopNow(new Date('2026-07-15T11:00:00Z')).hour >= 7);
});

// ─── Local day boundaries ───────────────────────────────────────────────────
// The run_key is a local date string. If it were derived from UTC, the
// digest would claim the wrong day's key for anything before 19:00/20:00
// local, which is most of the working day.

test('late evening local time still belongs to the local date, not the UTC one', () => {
  // 2026-09-01 23:30 EDT is 2026-09-02 03:30 UTC.
  const t = shopNow(new Date('2026-09-02T03:30:00Z'));
  assert.equal(t.date, '2026-09-01');
  assert.equal(t.month, '2026-09');
});

test('midnight local reports hour 0, not 24', () => {
  // Some ICU builds format midnight as '24' under hour12:false.
  const t = shopNow(new Date('2026-09-02T04:00:00Z')); // 00:00 EDT
  assert.equal(t.hour, 0);
  assert.equal(t.date, '2026-09-02');
});

// ─── Weekday gating ─────────────────────────────────────────────────────────

test('weekday detection matches the shop calendar, not UTC', () => {
  // 2026-09-05 is a Saturday. 2026-09-07 is a Monday.
  assert.equal(shopNow(new Date('2026-09-05T14:00:00Z')).isWeekday, false);
  assert.equal(shopNow(new Date('2026-09-07T14:00:00Z')).isWeekday, true);
  assert.equal(shopNow(new Date('2026-09-07T14:00:00Z')).weekday, 'Mon');
});

test('Saturday evening UTC that is still Friday locally counts as a weekday', () => {
  // 2026-09-05 02:00 UTC is 2026-09-04 22:00 EDT — a Friday.
  const t = shopNow(new Date('2026-09-05T02:00:00Z'));
  assert.equal(t.weekday, 'Fri');
  assert.equal(t.isWeekday, true);
});

// ─── ISO week keys ──────────────────────────────────────────────────────────
// The weekly digest claims one run per ISO week. Every day of a given week
// must produce the same key, or a redeploy mid-week re-sends it.

test('every day of one week produces the same run key', () => {
  const keys = [
    '2026-09-07', '2026-09-08', '2026-09-09',
    '2026-09-10', '2026-09-11', '2026-09-12', '2026-09-13',
  ].map(isoWeekKey);
  assert.equal(new Set(keys).size, 1, `expected one key, got ${[...new Set(keys)].join(', ')}`);
});

test('consecutive weeks produce different keys', () => {
  assert.notEqual(isoWeekKey('2026-09-07'), isoWeekKey('2026-09-14'));
});

test('the week key rolls at Monday, not Sunday', () => {
  // 2026-09-13 is a Sunday and belongs to the week starting 2026-09-07.
  assert.equal(isoWeekKey('2026-09-13'), isoWeekKey('2026-09-07'));
  assert.notEqual(isoWeekKey('2026-09-13'), isoWeekKey('2026-09-14'));
});

test('a year boundary does not collapse two weeks onto one key', () => {
  // 2026-12-28 (Mon) is ISO week 53 of 2026; 2027-01-04 (Mon) is week 1 of
  // 2027. A naive "week number" without the ISO year would collide.
  assert.notEqual(isoWeekKey('2026-12-28'), isoWeekKey('2027-01-04'));
});

test('early January days belonging to the previous ISO year key to it', () => {
  // 2027-01-01 is a Friday, in the ISO week that started 2026-12-28.
  assert.equal(isoWeekKey('2027-01-01'), isoWeekKey('2026-12-28'));
});
