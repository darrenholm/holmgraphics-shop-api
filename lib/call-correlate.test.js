// lib/call-correlate.test.js
//
// Run with:
//   node --test lib/call-correlate.test.js
//
// The behaviour under test is entirely about time, so the clock is injected.
// Nothing here touches the database or the network.

'use strict';

const test   = require('node:test');
const assert = require('node:assert/strict');
const {
  CallCorrelator,
  RETRY_WINDOW_MS,
  RING_GROUP_WINDOW_MS,
  CORRELATION_WINDOW_MS,
} = require('./call-correlate');

// A correlator whose clock we drive by hand.
function fixture(startMs = 1_700_000_000_000) {
  let now = startMs;
  const c = new CallCorrelator({ now: () => now });
  return { c, advance: (ms) => { now += ms; }, at: () => now };
}

const CALLER = { remoteE164: '+15198891343', remoteRaw: '15198891343' };

// ─── Ring-group collapse ────────────────────────────────────────────────────
// One inbound call rings six handsets; each fires its own Incoming Call event.
// All six are real events. Exactly one of them opens a pop.

test('a ring group produces one pop, not one per handset', () => {
  const { c, advance } = fixture();
  const exts = ['101', '102', '103', '104', '108', '110'];

  const results = exts.map((e) => {
    advance(120); // handsets fire a fraction of a second apart
    return c.ring({ ...CALLER, localExt: e });
  });

  assert.equal(results.filter((r) => r.isNewPop).length, 1);
  assert.equal(results[0].isNewPop, true);

  // …and every handset folds into the SAME pop, so an 'answered' event can
  // find the card that's already on screen.
  const keys = new Set(results.map((r) => r.key));
  assert.equal(keys.size, 1);
});

test('the pop accumulates the list of desks that rang', () => {
  const { c, advance } = fixture();
  c.ring({ ...CALLER, localExt: '101' });
  advance(100);
  c.ring({ ...CALLER, localExt: '104' });
  advance(100);
  const last = c.ring({ ...CALLER, localExt: '108' });
  assert.deepEqual([...last.ringingExts].sort(), ['101', '104', '108']);
});

test('a second call from the same number after the ring window opens a new pop', () => {
  const { c, advance } = fixture();
  const first = c.ring({ ...CALLER, localExt: '101' });
  advance(RING_GROUP_WINDOW_MS + 1_000);
  const second = c.ring({ ...CALLER, localExt: '101' });
  assert.equal(second.isNewPop, true);
  assert.notEqual(second.key, first.key);
});

test('hanging up closes the pop so an immediate callback pops again', () => {
  const { c, advance } = fixture();
  const first = c.ring({ ...CALLER, localExt: '101' });
  advance(5_000);
  c.close(CALLER);
  advance(1_000);
  const second = c.ring({ ...CALLER, localExt: '101' });
  assert.equal(second.isNewPop, true);
  assert.notEqual(second.key, first.key);
});

test('two different callers ringing at once get separate pops', () => {
  const { c } = fixture();
  const a = c.ring({ remoteE164: '+15198891343', remoteRaw: '15198891343', localExt: '101' });
  const b = c.ring({ remoteE164: '+15195073001', remoteRaw: '15195073001', localExt: '101' });
  assert.equal(a.isNewPop, true);
  assert.equal(b.isNewPop, true);
  assert.notEqual(a.key, b.key);
});

// ─── Retry dedupe ───────────────────────────────────────────────────────────
// The phone re-sends when it doesn't get a fast enough 200.

test('an identical event inside the retry window is a retry', () => {
  const { c, advance } = fixture();
  const ev = { event: 'ringing', ...CALLER, localExt: '101' };
  assert.equal(c.isRetry(ev), false);
  advance(500);
  assert.equal(c.isRetry(ev), true);
});

test('the same caller on a different handset is not a retry', () => {
  const { c, advance } = fixture();
  assert.equal(c.isRetry({ event: 'ringing', ...CALLER, localExt: '101' }), false);
  advance(200);
  assert.equal(c.isRetry({ event: 'ringing', ...CALLER, localExt: '104' }), false);
});

test('a different event type on the same handset is not a retry', () => {
  const { c, advance } = fixture();
  assert.equal(c.isRetry({ event: 'ringing',  ...CALLER, localExt: '101' }), false);
  advance(200);
  assert.equal(c.isRetry({ event: 'answered', ...CALLER, localExt: '101' }), false);
});

test('the same event again after the retry window is a fresh event', () => {
  const { c, advance } = fixture();
  const ev = { event: 'ringing', ...CALLER, localExt: '101' };
  assert.equal(c.isRetry(ev), false);
  advance(RETRY_WINDOW_MS + 1);
  assert.equal(c.isRetry(ev), false);
});

// ─── Lifecycle correlation ──────────────────────────────────────────────────
// No device call id exists, so answered/ended are matched on number + time.

test('answered and ended attach to the pop that rang', () => {
  const { c, advance } = fixture();
  const { key } = c.ring({ ...CALLER, localExt: '101' });
  advance(4_000);
  assert.equal(c.correlate(CALLER), key);
  advance(90_000);
  assert.equal(c.correlate(CALLER), key);
});

test('a stale answered event past the correlation window attaches to nothing', () => {
  const { c, advance } = fixture();
  c.ring({ ...CALLER, localExt: '101' });
  advance(CORRELATION_WINDOW_MS + 1_000);
  assert.equal(c.correlate(CALLER), null);
});

test('an answered event for a call that never rang here attaches to nothing', () => {
  // e.g. the API restarted while the phone was ringing.
  const { c } = fixture();
  assert.equal(c.correlate(CALLER), null);
});

// ─── Unparseable / blocked callers ──────────────────────────────────────────

test('a blocked caller still correlates with itself for the length of the call', () => {
  const { c, advance } = fixture();
  const blocked = { remoteE164: null, remoteRaw: 'Anonymous' };
  const { key, isNewPop } = c.ring({ ...blocked, localExt: '101' });
  assert.equal(isNewPop, true);
  advance(3_000);
  assert.equal(c.correlate(blocked), key);
});

test('a blocked caller does not collide with an unparseable different one', () => {
  const { c } = fixture();
  const a = c.ring({ remoteE164: null, remoteRaw: 'Anonymous',  localExt: '101' });
  const b = c.ring({ remoteE164: null, remoteRaw: 'Restricted', localExt: '101' });
  assert.notEqual(a.key, b.key);
});
