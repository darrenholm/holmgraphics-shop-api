// routes/lookup.test.js
//
// Employee retire/restore (PUT /employees/:id/active) and the active-only
// contract of GET /employees. Real Express, real auth middleware, real route
// code — only Postgres is faked, and each stub branch answers exactly one
// statement in routes/lookup.js so an edit there fails this file loudly
// rather than quietly stubbing the wrong thing.
//
// Run with:
//   node --test routes/lookup.test.js

'use strict';

const test   = require('node:test');
const assert = require('node:assert/strict');
const path   = require('node:path');
const Module = require('node:module');
const jwt    = require('jsonwebtoken');

process.env.JWT_SECRET  = 'test-secret-not-used-anywhere-real';
process.env.DATABASE_URL = 'postgres://stub';

// ─── Fake Postgres ──────────────────────────────────────────────────────────

// id → row. `active: null` models the pre-migration rows that were never
// given a flag; they must read as active everywhere.
let employees = {};
let openJobs     = 0;
let openTasks    = 0;
let openInstalls = 0;
const updates = [];   // [id, active] actually written

function reset() {
  employees = {
    7:  { id: 7,  first_name: 'Travis', last_name: 'Waugh',  email: 't@x.ca', role: 'staff',
          qbo_employee_id: null, phone_number: null, phone_extension: null,
          license_uploaded_at: null, active: true },
    9:  { id: 9,  first_name: 'Dana',   last_name: 'Adeyemi', email: 'd@x.ca', role: 'admin',
          qbo_employee_id: null, phone_number: null, phone_extension: null,
          license_uploaded_at: null, active: null },
    11: { id: 11, first_name: 'Sam',    last_name: 'Kovacs',  email: 's@x.ca', role: 'staff',
          qbo_employee_id: null, phone_number: null, phone_extension: null,
          license_uploaded_at: null, active: false },
  };
  openJobs = 0;
  openTasks = 0;
  openInstalls = 0;
  updates.length = 0;
}

// What the route's RETURNING / SELECT list hands back.
function shape(row) {
  return { ...row, active: row.active === null ? true : row.active };
}

async function fakeQuery(text, params = []) {
  if (text.includes('UPDATE employees')) {
    const [active, id] = params;
    updates.push([id, active]);
    const row = employees[id];
    if (!row) return [];
    row.active = active;
    return [shape(row)];
  }
  if (text.includes('AS open_jobs')) {
    // Guard the status vocabularies: job_tasks and project_install_schedule
    // have DIFFERENT status sets (migration 035) and mixing them up silently
    // counts nothing. These asserts are the point of this branch.
    assert.match(text, /jt\.status IN \('pending', 'in_progress', 'blocked'\)/,
      'job_tasks statuses are pending/in_progress/completed/blocked/skipped');
    assert.match(text, /pis\.status IN \('scheduled', 'in_progress', 'postponed'\)/,
      'project_install_schedule statuses are scheduled/in_progress/completed/postponed/cancelled');
    // Installs hang off the person-resource (migration 039), not the employee.
    assert.match(text, /r\.employee_id = \$1/,
      'installs are crewed by resource, joined back to the employee');
    return [{ open_jobs: openJobs, open_tasks: openTasks, open_installs: openInstalls }];
  }
  if (text.includes('FROM employees')) {
    const all = Object.values(employees).map(shape);
    const rows = text.includes('WHERE TRUE') ? all : all.filter((r) => r.active);
    // ORDER BY COALESCE(active, TRUE) DESC, last_name, first_name
    return rows.sort((a, b) =>
      (Number(b.active) - Number(a.active)) || a.last_name.localeCompare(b.last_name));
  }
  throw new Error(`unexpected query in test: ${text.slice(0, 80)}`);
}

const connPath = require.resolve(path.join(__dirname, '..', 'db', 'connection.js'));
require.cache[connPath] = new Module(connPath, null);
require.cache[connPath].filename = connPath;
require.cache[connPath].loaded = true;
require.cache[connPath].exports = {
  query: fakeQuery,
  queryOne: async (t, p) => (await fakeQuery(t, p))[0] || null,
  pool: { connect: async () => { throw new Error('not used'); }, end: async () => {} },
};

const express      = require('express');
const lookupRoutes = require('../routes/lookup');

// ─── Harness ────────────────────────────────────────────────────────────────

// id 9 is the signed-in admin, so id 9 is also the "yourself" case.
const adminJwt = jwt.sign({ id: 9, role: 'admin', name: 'Dana Adeyemi' }, process.env.JWT_SECRET);
const staffJwt = jwt.sign({ id: 7, role: 'staff', name: 'Travis Waugh' }, process.env.JWT_SECRET);

let server, base;

test.before(async () => {
  const app = express();
  app.use(express.json());
  app.use('/api', lookupRoutes);
  await new Promise((r) => { server = app.listen(0, '127.0.0.1', r); });
  base = `http://127.0.0.1:${server.address().port}`;
});

test.after(() => { server?.close(); });

function setActive(id, active, token = adminJwt) {
  return fetch(`${base}/api/employees/${id}/active`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({ active }),
  });
}

function list(qs = '', token = adminJwt) {
  return fetch(`${base}/api/employees${qs}`, { headers: { Authorization: `Bearer ${token}` } });
}

// ─── Retiring someone who has left ──────────────────────────────────────────

test('deactivating writes active=false and reports the work still on them', async () => {
  reset();
  openJobs = 3;
  openTasks = 2;
  openInstalls = 1;

  const res = await setActive(7, false);
  assert.equal(res.status, 200);
  const body = await res.json();

  assert.equal(body.active, false);
  assert.deepEqual(updates, [[7, false]]);
  // The counts are the whole point of the response: job notifications follow
  // the job's assignee, not this flag, so anything left on them keeps texting
  // them after they have gone.
  assert.equal(body.open_jobs, 3);
  assert.equal(body.open_tasks, 2);
  assert.equal(body.open_installs, 1);
});

test('open work does not block the deactivation', async () => {
  reset();
  openJobs = 12;
  openTasks = 9;
  openInstalls = 4;

  const res = await setActive(7, false);
  assert.equal(res.status, 200, 'a stale assignment must never keep a departed employee active');
  assert.equal(employees[7].active, false);
});

test('reactivating clears the flag and reports no counts', async () => {
  reset();
  const res = await setActive(11, true);
  assert.equal(res.status, 200);
  const body = await res.json();

  assert.equal(body.active, true);
  assert.deepEqual(updates, [[11, true]]);
  assert.equal('open_jobs' in body, false, 'counting open work on a restore is noise');
  assert.equal('open_installs' in body, false);
});

// ─── Guards ─────────────────────────────────────────────────────────────────

test('an admin cannot deactivate their own account', async () => {
  reset();
  const res = await setActive(9, false);
  assert.equal(res.status, 400);
  assert.match((await res.json()).message, /your own account/i);
  assert.deepEqual(updates, [], 'nothing may be written');
});

test('an admin can still reactivate themselves', async () => {
  reset();
  const res = await setActive(9, true);
  assert.equal(res.status, 200);
});

test('active must be a boolean, not a string', async () => {
  reset();
  const res = await fetch(`${base}/api/employees/7/active`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${adminJwt}` },
    body: JSON.stringify({ active: 'false' }),
  });
  // 'false' is truthy in JS — accepting it would activate the very person
  // someone was trying to retire.
  assert.equal(res.status, 400);
  assert.deepEqual(updates, []);
});

test('a missing employee is a 404', async () => {
  reset();
  const res = await setActive(4242, false);
  assert.equal(res.status, 404);
});

test('a non-numeric id is a 400', async () => {
  reset();
  const res = await setActive('abc', false);
  assert.equal(res.status, 400);
  assert.deepEqual(updates, []);
});

test('staff cannot retire anyone', async () => {
  reset();
  const res = await setActive(11, false, staffJwt);
  assert.equal(res.status, 403);
  assert.deepEqual(updates, [], 'nothing may be written');
});

test('an unauthenticated call is rejected', async () => {
  reset();
  const res = await fetch(`${base}/api/employees/7/active`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ active: false }),
  });
  assert.equal(res.status, 401);
  assert.deepEqual(updates, []);
});

// ─── GET /employees stays active-only for the dropdowns ─────────────────────

test('the employee list hides inactive staff by default', async () => {
  reset();
  const rows = await (await list()).json();
  const ids = rows.map((r) => r.id);

  assert.deepEqual(ids.sort(), [7, 9], 'Sam (active=false) must not reach an assignee dropdown');
  // active=null predates the flag and has to read as active.
  assert.equal(rows.find((r) => r.id === 9).active, true);
});

test('?include_inactive=1 returns retired staff too, active first', async () => {
  reset();
  const rows = await (await list('?include_inactive=1')).json();

  assert.deepEqual(rows.map((r) => r.id), [9, 7, 11]);
  assert.equal(rows.at(-1).active, false);
});
