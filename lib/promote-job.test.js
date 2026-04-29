// lib/promote-job.test.js
// Unit tests for the promote-job helper. Run with:
//
//   node --test lib/promote-job.test.js
//
// Mocks the pg client so these tests are self-contained — no DB required.
// The helper's correctness comes down to three things:
//   1. It only runs the UPDATE when both order preconditions are met
//      (paid + (designs exist OR no decorations)).
//   2. The UPDATE's WHERE clause makes it idempotent and never overwrites
//      a manual reassignment of production_emp_id, regresses status_id,
//      or clobbers a staff-edited project description.
//   3. The recipient name resolves correctly for ship vs pickup orders.
// The mock client lets us assert (1) by inspecting which queries ran, and
// gives us a hook to assert (2)/(3) by feeding it canned check-query results.

'use strict';

const test   = require('node:test');
const assert = require('node:assert/strict');
const { maybePromoteJob, _internals } = require('./promote-job');

const { PRODUCTION_EMP_ID_BRADY, STATUS_ID_QUOTE, STATUS_ID_ORDERED } = _internals;

// Build a mock pg client that returns canned responses, in order, for each
// query the helper makes. Records every call so tests can assert on what
// SQL ran with which params.
function makeClient(responses) {
  const calls = [];
  let i = 0;
  return {
    calls,
    query: async (text, params) => {
      calls.push({ text, params });
      const r = responses[i++];
      if (!r) throw new Error(`mock client: no response queued for call #${calls.length}`);
      return r;
    },
  };
}

// Minimal pg-like result helper.
function rows(arr) {
  return { rows: arr, rowCount: arr.length };
}

// Default check-query row. Tests override fields via spread.
function checkRow(overrides = {}) {
  return {
    job_id:          42,
    is_paid:         true,
    has_design:      true,
    has_decorations: true,
    recipient_name:  'Test Customer',
    ...overrides,
  };
}

// ─── Argument validation ─────────────────────────────────────────────────────

test('throws when client is missing or invalid', async () => {
  await assert.rejects(() => maybePromoteJob(null, 1), /pg client is required/);
  await assert.rejects(() => maybePromoteJob({}, 1),   /pg client is required/);
});

test('throws when orderId is missing', async () => {
  const client = makeClient([]);
  await assert.rejects(() => maybePromoteJob(client, undefined), /orderId is required/);
  await assert.rejects(() => maybePromoteJob(client, null),      /orderId is required/);
});

// ─── Precondition gating ─────────────────────────────────────────────────────

test('returns order_not_found when order does not exist', async () => {
  const client = makeClient([rows([])]);
  const result = await maybePromoteJob(client, 999);
  assert.deepEqual(result, { promoted: false, reason: 'order_not_found' });
  assert.equal(client.calls.length, 1, 'should not run UPDATE if order missing');
});

test('returns not_paid when paid_at is null', async () => {
  const client = makeClient([
    rows([checkRow({ is_paid: false })]),
  ]);
  const result = await maybePromoteJob(client, 1);
  assert.deepEqual(result, { promoted: false, reason: 'not_paid', job_id: 42 });
  assert.equal(client.calls.length, 1, 'should not run UPDATE when not paid');
});

test('returns no_designs when decorations exist but no design rows', async () => {
  const client = makeClient([
    rows([checkRow({ has_design: false, has_decorations: true })]),
  ]);
  const result = await maybePromoteJob(client, 1);
  assert.deepEqual(result, { promoted: false, reason: 'no_designs', job_id: 42 });
  assert.equal(client.calls.length, 1, 'decorated order without designs must wait');
});

// ─── Happy path ──────────────────────────────────────────────────────────────

test('promotes when paid + designs exist (decorated order)', async () => {
  const client = makeClient([
    rows([checkRow({ has_design: true, has_decorations: true })]),
    rows([{ id: 42, production_emp_id: PRODUCTION_EMP_ID_BRADY, status_id: STATUS_ID_ORDERED, description: 'Test Customer-Online' }]),
  ]);
  const result = await maybePromoteJob(client, 1);
  assert.equal(result.promoted, true);
  assert.equal(result.job_id, 42);
  assert.equal(result.project.production_emp_id, PRODUCTION_EMP_ID_BRADY);
  assert.equal(result.project.status_id, STATUS_ID_ORDERED);
  assert.equal(result.project.description, 'Test Customer-Online');
  assert.equal(client.calls.length, 2, 'should run check + UPDATE');
});

test('promotes a no-decoration order without waiting on a design row', async () => {
  // $0-decoration garment-only order: no order_decorations, so no designs row
  // ever gets inserted. Must still promote so the job leaves status_id 1.
  const client = makeClient([
    rows([checkRow({ has_design: false, has_decorations: false })]),
    rows([{ id: 42, production_emp_id: PRODUCTION_EMP_ID_BRADY, status_id: STATUS_ID_ORDERED, description: 'Test Customer-Online' }]),
  ]);
  const result = await maybePromoteJob(client, 1);
  assert.equal(result.promoted, true);
  assert.equal(result.job_id, 42);
  assert.equal(client.calls.length, 2, 'should run check + UPDATE for no-decoration orders too');
});

test('UPDATE is parameterized with job_id, brady, ordered, quote, project_name', async () => {
  const client = makeClient([
    rows([checkRow({ job_id: 77, recipient_name: 'Darren Holm' })]),
    rows([{ id: 77, production_emp_id: PRODUCTION_EMP_ID_BRADY, status_id: STATUS_ID_ORDERED, description: 'Darren Holm-Online' }]),
  ]);
  await maybePromoteJob(client, 5);
  const updateCall = client.calls[1];
  assert.match(updateCall.text, /UPDATE projects/);
  assert.deepEqual(updateCall.params, [
    77,
    PRODUCTION_EMP_ID_BRADY,
    STATUS_ID_ORDERED,
    STATUS_ID_QUOTE,
    'Darren Holm-Online',
  ]);
});

test('check query asks orders → clients for recipient_name', async () => {
  const client = makeClient([
    rows([checkRow()]),
    rows([{ id: 42, production_emp_id: PRODUCTION_EMP_ID_BRADY, status_id: STATUS_ID_ORDERED, description: 'Test Customer-Online' }]),
  ]);
  await maybePromoteJob(client, 1);
  const checkCall = client.calls[0];
  // The check query must JOIN clients so recipient_name fallbacks (company,
  // fname/lname) work for pickup orders where ship_to_name is NULL.
  assert.match(checkCall.text, /JOIN clients/i);
  assert.match(checkCall.text, /recipient_name/);
  assert.match(checkCall.text, /has_decorations/);
});

// ─── Idempotency ─────────────────────────────────────────────────────────────

test('returns no_change_needed when UPDATE matches zero rows', async () => {
  // Simulate a project that's already at (Brady, Ordered, named) — the
  // UPDATE's guard clause will match zero rows, returning rowCount=0.
  const client = makeClient([
    rows([checkRow()]),
    rows([]),
  ]);
  const result = await maybePromoteJob(client, 1);
  assert.deepEqual(result, { promoted: false, reason: 'no_change_needed', job_id: 42 });
});

// ─── SQL shape ───────────────────────────────────────────────────────────────
// Light asserts on the UPDATE so a refactor that strips the safety guards
// gets caught. Full DB-backed assertion of the WHERE/SET semantics belongs
// in an integration test against a real Postgres.

test('UPDATE preserves manually-assigned production_emp_id, status, and description', () => {
  const fs = require('fs');
  const path = require('path');
  const src = fs.readFileSync(path.join(__dirname, 'promote-job.js'), 'utf8');
  assert.match(src, /COALESCE\(production_emp_id/, 'COALESCE protects manual assignments');
  assert.match(src, /WHEN status_id IS NULL OR status_id = \$4/, 'CASE protects against status regression');
  assert.match(src, /WHEN description IS NULL OR TRIM\(description\) = ''/, 'CASE protects manual project rename');
});
