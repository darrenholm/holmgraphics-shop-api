// routes/election.test.js
//
// POST /api/election/jobs/:id/items — staff adding an election basket to a job
// that already exists. A real Express app over real HTTP; only Postgres and
// the apparel catalogue (which reads Postgres) are faked.
//
// Run with:
//   node --test routes/election.test.js

'use strict';

const test   = require('node:test');
const assert = require('node:assert/strict');
const path   = require('node:path');
const jwt    = require('jsonwebtoken');

process.env.JWT_SECRET = 'test-secret-not-used-anywhere-real';
process.env.DATABASE_URL = 'postgres://stub';

// ─── Fake Postgres ──────────────────────────────────────────────────────────
const items = [];
const notes = [];
const draftUpdates = [];
const touched = [];
let projects = {}; // id → { id, client_id, description, status_name, client_name }

function reset() {
  items.length = 0;
  notes.length = 0;
  draftUpdates.length = 0;
  touched.length = 0;
  projects = {};
}

async function fakeQuery(text, params = []) {
  if (text.includes('INSERT INTO items')) { items.push(params); return []; }
  if (text.includes('INSERT INTO notes')) { notes.push(params); return []; }
  if (text.includes('UPDATE election_drafts')) { draftUpdates.push(params); return []; }
  if (text.includes('UPDATE projects SET updated_at')) { touched.push(params[0]); return []; }
  throw new Error(`unexpected query: ${text}`);
}

async function fakeQueryOne(text, params = []) {
  if (text.includes('FROM projects p')) return projects[params[0]] || null;
  throw new Error(`unexpected queryOne: ${text}`);
}

function stub(relative, exports) {
  const file = require.resolve(path.join(__dirname, '..', relative));
  require.cache[file] = { id: file, filename: file, loaded: true, exports };
}

stub('db/connection', { query: fakeQuery, queryOne: fakeQueryOne });
stub('lib/election-apparel', {
  apparelOptions: async () => [],
  printLocations: async () => [],
  priceApparel: async () => ({ lines: [], warnings: [] }),
});

const express = require('express');
const { catalogue } = require('../lib/election-catalogue');
const router = require('./election');

const app = express();
app.use(express.json());
app.use('/api/election', router);

const staffToken = jwt.sign({ id: 1, role: 'staff' }, process.env.JWT_SECRET);
const clientToken = jwt.sign({ id: 9, role: 'client' }, process.env.JWT_SECRET);

function oneSheetOfSigns() {
  const cat = catalogue();
  const cut = cat.sign_cuts[0];
  return {
    signs: [{ cutKey: cut.key, sheetKey: cat.sheet_options[0].key, quantity: cut.perSheet, stands: 0 }],
    needs_artwork: true,
  };
}

let server;
let base;

test.before(async () => {
  server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}/api/election`;
});

test.after(() => server.close());
test.beforeEach(reset);

function post(id, body, token = staffToken) {
  return fetch(`${base}/jobs/${id}/items`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(body),
  });
}

test('adds the priced lines to the existing job, under that job\'s client', async () => {
  projects[10011] = {
    id: 10011, client_id: 1129, description: 'Election signs',
    status_name: 'Design', client_name: 'Steve Adams',
  };

  const res = await post(10011, { ...oneSheetOfSigns(), draft_code: 'BCDF2345', notes: 'Pick up Friday' });
  assert.equal(res.status, 201);
  const body = await res.json();

  assert.equal(body.id, 10011);
  assert.equal(body.added, true);
  assert.equal(body.status, 'Design');
  assert.equal(body.client_name, 'Steve Adams');

  // Sign line plus artwork, both on job 10011.
  assert.equal(items.length, 2);
  assert.ok(items.every((row) => row[0] === 10011));
  assert.equal(body.lines.length, 2);

  assert.deepEqual(notes, [[10011, 'Pick up Friday']]);
  // The draft is marked with the job's own client, not whoever is signed in.
  assert.deepEqual(draftUpdates, [[10011, 1129, 'BCDF2345']]);
  assert.deepEqual(touched, [10011]);
});

test('refuses without a staff token', async () => {
  projects[10011] = { id: 10011, client_id: 1129, status_name: 'Design' };

  assert.equal((await post(10011, oneSheetOfSigns(), null)).status, 401);
  assert.equal((await post(10011, oneSheetOfSigns(), clientToken)).status, 403);
  assert.equal(items.length, 0);
});

test('a job number that does not exist adds nothing', async () => {
  const res = await post(99999, oneSheetOfSigns());
  assert.equal(res.status, 404);
  assert.match((await res.json()).message, /no job #99999/);
  assert.equal(items.length, 0);
});

test('a Complete job is refused as a likely typo', async () => {
  projects[10012] = { id: 10012, client_id: 1, status_name: 'Complete' };

  const res = await post(10012, oneSheetOfSigns());
  assert.equal(res.status, 409);
  assert.equal(items.length, 0);
});

test('an empty basket adds nothing', async () => {
  projects[10011] = { id: 10011, client_id: 1129, status_name: 'Design' };

  const res = await post(10011, { signs: [], needs_artwork: true });
  assert.equal(res.status, 400);
  assert.equal(items.length, 0);
});
