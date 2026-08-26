// routes/telephony.test.js
//
// End-to-end test of the screen pop over real HTTP: a real Express app, a
// real SSE connection, real Action-URL-shaped requests. Only Postgres is
// faked — the query stub below answers the handful of statements
// lib/screen-pop.js issues and records every INSERT.
//
// Run with:
//   node --test routes/telephony.test.js
//
// These cases are the spec's acceptance criteria, in order.

'use strict';

const test    = require('node:test');
const assert  = require('node:assert/strict');
const path    = require('node:path');
const Module  = require('node:module');
const jwt     = require('jsonwebtoken');

// ─── Environment must be set BEFORE routes/telephony.js is required ─────────
const TOKEN = 'Dq4CVTmyQIUZ';
process.env.TELEPHONY_INGEST_TOKEN = TOKEN;
process.env.JWT_SECRET = 'test-secret-not-used-anywhere-real';
process.env.DATABASE_URL = 'postgres://stub';

// ─── Fake Postgres ──────────────────────────────────────────────────────────
// Matching on SQL text is brittle in general; here it's deliberate. Each
// branch corresponds to exactly one statement in lib/screen-pop.js, so if
// someone edits a query out from under this file the test fails loudly
// rather than quietly stubbing the wrong thing.
const inserts = [];
let indexRows = [];   // { e164, client_id, name, company }
let clientJobs = {};  // client_id → job rows
let clientOwed = {};  // client_id → number

function reset() {
  inserts.length = 0;
  indexRows = [];
  clientJobs = {};
  clientOwed = {};
}

async function fakeQuery(text, params = []) {
  if (text.includes('INSERT INTO calls')) {
    inserts.push(params);
    return [];
  }
  if (text.includes('FROM client_phone_index')) {
    const e164 = params[0];
    return indexRows
      .filter((r) => r.e164 === e164)
      .map((r) => ({
        id: r.client_id,
        name: r.name,
        company: r.company ?? null,
        contact_name: r.contact_name ?? '',
        email: r.email ?? null,
      }));
  }
  if (text.includes('FROM projects p')) return clientJobs[params[0]] || [];
  if (text.includes('FROM orders'))     return [{ owed: clientOwed[params[0]] || 0 }];
  if (text.includes('FROM employees'))  return params[0] === '104' ? [{ name: 'Brady Yzerman' }] : [];
  if (text.includes('FROM calls'))      return [];
  throw new Error(`unexpected query in test: ${text.slice(0, 80)}`);
}

// Plant the stub in the module cache at the exact path routes/telephony.js
// will resolve, before it is required.
const connPath = require.resolve(path.join(__dirname, '..', 'db', 'connection.js'));
require.cache[connPath] = new Module(connPath, null);
require.cache[connPath].filename = connPath;
require.cache[connPath].loaded = true;
require.cache[connPath].exports = {
  query: fakeQuery,
  queryOne: async (t, p) => (await fakeQuery(t, p))[0] || null,
  pool: { connect: async () => { throw new Error('not used'); }, end: async () => {} },
};

const express        = require('express');
const telephonyRoutes = require('../routes/telephony');

// ─── Harness ────────────────────────────────────────────────────────────────

const staffJwt = jwt.sign({ id: 1, role: 'staff', name: 'Test Staff' }, process.env.JWT_SECRET);

let server, base;

test.before(async () => {
  const app = express();
  app.use(express.json());
  app.use('/', telephonyRoutes);
  await new Promise((r) => { server = app.listen(0, '127.0.0.1', r); });
  base = `http://127.0.0.1:${server.address().port}`;
});

test.after(() => {
  // SSE connections are, by design, never finished. server.close() alone
  // waits for them and the runner would hang after the last assertion.
  server?.closeAllConnections?.();
  server?.close();
});

// Each test uses its OWN caller number. The correlator is a module-level
// singleton with real 10s retry and 20s ring-group windows, so two tests
// sharing a number would have the second one's first event swallowed as a
// retry of the first one's — which is the correlator behaving correctly and
// the test lying about it.
//
// Fire an Action URL exactly as a handset would.
function ring(qs, prefix = 't', token = TOKEN) {
  return fetch(`${base}/${prefix}/${token}?${qs}`);
}

// Hold an SSE connection and collect parsed events.
async function openStream(authToken = staffJwt) {
  const controller = new AbortController();
  const res = await fetch(`${base}/api/telephony/stream`, {
    headers: { Authorization: `Bearer ${authToken}` },
    signal: controller.signal,
  });
  const events = [];
  if (res.ok && res.body) {
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = '';
    (async () => {
      try {
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          buf += dec.decode(value, { stream: true });
          let i;
          while ((i = buf.indexOf('\n\n')) !== -1) {
            const frame = buf.slice(0, i);
            buf = buf.slice(i + 2);
            const data = frame.split('\n').filter((l) => l.startsWith('data:'))
              .map((l) => l.slice(5).trim()).join('\n');
            if (data) events.push(JSON.parse(data));
          }
        }
      } catch { /* aborted */ }
    })();
  }
  return { res, events, close: () => controller.abort() };
}

// The ingest handler answers before it does any work, so give the async tail
// a moment to land. Generous enough not to flake, short enough to stay fast.
const settle = (ms = 250) => new Promise((r) => setTimeout(r, ms));

// ─── 4. Bad token returns 401 and logs nothing sensitive ────────────────────

test('a bad token is rejected and nothing is recorded', async () => {
  reset();
  const res = await ring('r=15198891343&e=101', 't', 'wrong-token-entirely');
  assert.equal(res.status, 401);
  await settle();
  assert.equal(inserts.length, 0, 'an unauthorized request must not write a call row');
});

test('a token of a different length is rejected without throwing', async () => {
  // timingSafeEqual throws on length mismatch if you hand it raw buffers.
  // Hashing first is what makes this safe; this pins that.
  reset();
  assert.equal((await ring('r=1&e=1', 't', 'x')).status, 401);
  assert.equal((await ring('r=1&e=1', 't', 'x'.repeat(200))).status, 401);
  assert.equal((await ring('r=1&e=1', 't', '')).status, 404); // empty → no route match
});

// ─── 1 & 9. A known caller pops their card ──────────────────────────────────

test('a known caller pops a full card, matching a differently-formatted stored number', async () => {
  reset();
  // Stored in the DB as (519) 889-1343 → indexed as +15198891343.
  indexRows = [{ e164: '+15198891343', client_id: 42, name: 'Acme Signs Inc.',
                 company: 'Acme Signs Inc.', contact_name: 'Dave Acme', email: 'dave@acme.ca' }];
  clientJobs = { 42: [
    { id: 9198, description: 'Storefront channel letters', status: 'Production',
      created_date: '2026-07-01T12:00:00Z', due_date: null, total: '29258.45' },
    { id: 9210, description: 'Truck lettering', status: 'Design',
      created_date: '2026-08-14T12:00:00Z', due_date: null, total: '840.00' },
  ] };
  clientOwed = { 42: 129.99 };

  const stream = await openStream();
  // The caller ID arrives bare, 11 digits, no punctuation — exactly as the
  // handset sends it.
  await ring('r=15198891343&e=101');
  await settle();

  assert.equal(stream.events.length, 1);
  const p = stream.events[0];
  assert.equal(p.event, 'ringing');
  assert.equal(p.match, 'one');
  assert.equal(p.remoteE164, '+15198891343');
  assert.equal(p.remoteDisplay, '(519) 889-1343');
  assert.equal(p.localExt, '101');

  const c = p.clients[0];
  assert.equal(c.id, 42);
  assert.equal(c.name, 'Acme Signs Inc.');
  assert.equal(c.openJobCount, 2);
  assert.equal(c.openJobs[0].number, 9198);
  assert.equal(c.openJobs[0].total, 29258.45);
  assert.equal(c.unpaidOrders, 129.99);
  // Oldest open job drives the "waiting since" line.
  assert.equal(new Date(c.oldestOpenJobAt).toISOString(), '2026-07-01T12:00:00.000Z');

  stream.close();
});

test('recent quotes ride along on the card but are counted separately', async () => {
  // Rolling quotes into "open jobs" would turn one job in production into
  // "seven open jobs" and make the number useless at a glance.
  reset();
  indexRows = [{ e164: '+15198891305', client_id: 42, name: 'Acme Signs Inc.' }];
  clientJobs = { 42: [
    { id: 8302, description: 'Monument sign', status: 'Production', is_quote: false,
      created_date: '2026-05-01T12:00:00Z', due_date: null, total: '4200.00' },
    { id: 9618, description: 'LED test', status: 'Quote', is_quote: true,
      created_date: '2026-08-01T12:00:00Z', due_date: null, total: '0' },
    { id: 9604, description: 'Online order', status: 'Quote', is_quote: true,
      created_date: '2026-07-20T12:00:00Z', due_date: null, total: '0' },
  ] };

  const stream = await openStream();
  await ring('r=15198891305&e=101');
  await settle();

  const c = stream.events[0].clients[0];
  assert.equal(c.openJobCount, 1, 'quotes must not inflate the open-job count');
  assert.equal(c.recentQuoteCount, 2);
  // All three are reachable from the card…
  assert.equal(c.openJobs.length, 3);
  assert.equal(c.openJobs[0].number, 8302);
  assert.equal(c.openJobs[0].isQuote, false);
  assert.equal(c.openJobs[1].isQuote, true);
  // …and "oldest" ignores quotes, or an unaccepted quote would make the
  // waiting-since figure lie.
  assert.equal(new Date(c.oldestOpenJobAt).toISOString(), '2026-05-01T12:00:00.000Z');
  stream.close();
});

// ─── 2. Unknown number still pops ───────────────────────────────────────────

test('an unknown number pops with no client attached', async () => {
  reset();
  const stream = await openStream();
  await ring('r=15195551234&e=101');
  await settle();

  assert.equal(stream.events.length, 1);
  assert.equal(stream.events[0].match, 'none');
  assert.deepEqual(stream.events[0].clients, []);
  assert.equal(stream.events[0].remoteE164, '+15195551234');
  stream.close();
});

// ─── Several clients share one number: never guess ──────────────────────────

test('a number shared by two clients pops both, unresolved', async () => {
  reset();
  indexRows = [
    { e164: '+15195073001', client_id: 7,  name: 'Holm Graphics' },
    { e164: '+15195073001', client_id: 12, name: 'Holmdale Rodeo' },
  ];
  const stream = await openStream();
  await ring('r=15195073001&e=101');
  await settle();

  assert.equal(stream.events[0].match, 'many');
  assert.equal(stream.events[0].clients.length, 2);
  stream.close();
});

// ─── 3. Blocked caller ID does not error ────────────────────────────────────

test('a blocked caller pops as anonymous and still logs', async () => {
  reset();
  const stream = await openStream();
  await ring('r=&e=101');            // empty string — the usual shape
  await settle();
  await ring('r=Anonymous&e=101');   // some carriers send a word
  await settle();

  assert.equal(stream.events.length, 2);
  assert.equal(stream.events[0].match, 'anonymous');
  assert.equal(stream.events[1].match, 'anonymous');
  assert.equal(inserts.length, 2);
  stream.close();
});

test('an unsupported Action URL variable arriving as literal text does not crash', async () => {
  // $call_id is not supported on this firmware; it comes through verbatim.
  reset();
  const stream = await openStream();
  const res = await ring('r=%24call_id&e=101');
  assert.equal(res.status, 200);
  await settle();
  assert.equal(stream.events[0].match, 'anonymous');
  stream.close();
});

test('an internal extension-to-extension call is logged but never matched to a client', async () => {
  reset();
  const stream = await openStream();
  await ring('r=104&e=101');
  await settle();
  assert.equal(stream.events[0].match, 'internal');
  assert.equal(stream.events[0].remoteE164, null);
  assert.equal(inserts.length, 1);
  stream.close();
});

// ─── 8. A ring group produces ONE pop ───────────────────────────────────────

test('a ring group rings six handsets and pops once, logging all six', async () => {
  reset();
  indexRows = [{ e164: '+15198891301', client_id: 42, name: 'Acme Signs Inc.' }];
  const stream = await openStream();

  for (const ext of ['101', '102', '103', '104', '108', '110']) {
    await ring(`r=15198891301&e=${ext}`);
  }
  await settle(400);

  assert.equal(stream.events.length, 1, 'one call, one pop');
  assert.equal(inserts.length, 6, 'every handset that rang is still logged');
  // …and each row records which desk rang.
  assert.deepEqual(inserts.map((p) => p[4]).sort(),
                   ['101', '102', '103', '104', '108', '110']);
  stream.close();
});

test('the same handset re-firing an identical event inside 10s is treated as a retry', async () => {
  reset();
  const stream = await openStream();
  await ring('r=15195559999&e=101');
  await settle();
  await ring('r=15195559999&e=101');   // phone retried — same event, same desk
  await settle();

  assert.equal(stream.events.length, 1);
  assert.equal(inserts.length, 1, 'a retry must not double-log');
  stream.close();
});

// ─── 5. Every call lands in `calls` ─────────────────────────────────────────

test('the log row carries the resolved client, the raw string, and the E.164 form', async () => {
  reset();
  indexRows = [{ e164: '+15198891302', client_id: 42, name: 'Acme Signs Inc.' }];
  await ring('r=15198891302&e=101');
  await settle();

  assert.equal(inserts.length, 1);
  const [event, direction, raw, e164, ext, clientId] = inserts[0];
  assert.equal(event, 'ringing');
  assert.equal(direction, 'inbound');
  assert.equal(raw, '15198891302');    // exactly as the phone sent it
  assert.equal(e164, '+15198891302');
  assert.equal(ext, '101');
  assert.equal(clientId, 42);
});

test('an unmatched call is logged too, with a null client', async () => {
  reset();
  await ring('r=15195550000&e=101');
  await settle();
  assert.equal(inserts.length, 1);
  assert.equal(inserts[0][5], null);
});

// ─── Lifecycle: answered / ended attach to the pop that rang ────────────────

test('answered and ended update the card the ring opened', async () => {
  reset();
  indexRows = [{ e164: '+15198891303', client_id: 42, name: 'Acme Signs Inc.' }];
  const stream = await openStream();

  await ring('r=15198891303&e=101');
  await settle();
  await ring('r=15198891303&e=104', 'ta');   // Brady picked up on 104
  await settle();
  await ring('r=15198891303&e=104', 'te');
  await settle();

  assert.equal(stream.events.length, 3);
  const [rang, answered, ended] = stream.events;
  assert.equal(rang.event, 'ringing');
  assert.equal(answered.event, 'answered');
  assert.equal(ended.event, 'ended');
  // All three carry the SAME key, so the browser updates one card instead of
  // stacking three. This is the whole point of server-side correlation —
  // the hardware supplies no call id to join on.
  assert.equal(answered.key, rang.key);
  assert.equal(ended.key, rang.key);
  // …and 'answered' is the only event that knows who took the call.
  assert.equal(answered.handledBy, 'Brady Yzerman');
  assert.equal(rang.handledBy, null);
  stream.close();
});

test('an outgoing call is logged with direction outbound', async () => {
  reset();
  await ring('r=15198891304&e=101', 'to');
  await settle();
  assert.equal(inserts[0][1], 'outbound');
});

// ─── 6. Reconnect ───────────────────────────────────────────────────────────

test('a dropped stream reconnects and receives subsequent calls', async () => {
  reset();
  const first = await openStream();
  first.close();
  await settle(100);

  const second = await openStream();
  await ring('r=15195557777&e=101');
  await settle();

  assert.equal(second.events.length, 1, 'the reconnected stream receives the pop');
  assert.equal(first.events.length, 0, 'the closed stream receives nothing');
  second.close();
});

test('two browsers both receive the same pop', async () => {
  reset();
  const a = await openStream();
  const b = await openStream();
  await ring('r=15195558888&e=101');
  await settle();
  assert.equal(a.events.length, 1);
  assert.equal(b.events.length, 1);
  assert.equal(a.events[0].key, b.events[0].key);
  a.close(); b.close();
});

// ─── Stream auth ────────────────────────────────────────────────────────────

test('the stream requires a staff session', async () => {
  const res = await fetch(`${base}/api/telephony/stream`);
  assert.equal(res.status, 401);

  const clientToken = jwt.sign({ id: 9, role: 'client' }, process.env.JWT_SECRET);
  const res2 = await fetch(`${base}/api/telephony/stream`, {
    headers: { Authorization: `Bearer ${clientToken}` },
  });
  assert.equal(res2.status, 403);
  // Drain so the connection doesn't linger.
  await res.text(); await res2.text();
});

// ─── The phone must not be kept waiting ─────────────────────────────────────

test('the handset gets its 200 before any database work happens', async () => {
  reset();
  const started = Date.now();
  const res = await ring('r=15195551111&e=101');
  const elapsed = Date.now() - started;
  assert.equal(res.status, 200);
  assert.ok(elapsed < 150, `ack took ${elapsed}ms — the phone should not wait on the DB`);
});
