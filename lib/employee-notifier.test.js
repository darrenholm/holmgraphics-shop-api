// lib/employee-notifier.test.js
//
// Run with:
//   node --test lib/employee-notifier.test.js
//
// Covers sendJobMessageSms (the manual "text the assignee" button) with a
// fake db. sms.js runs in stub mode here (no SkySwitch env in tests), so
// sends "succeed" without touching the network — which also locks in that
// stub sends are treated as ok and logged.

'use strict';

const test   = require('node:test');
const assert = require('node:assert/strict');
const { sendJobMessageSms, _internals } = require('./employee-notifier');

// Minimal fake of db/connection: queryOne answers the project lookup,
// query records the sms_log insert.
function fakeDb(projectRow) {
  const inserts = [];
  return {
    inserts,
    queryOne: async () => projectRow,
    query: async (sql, params) => { inserts.push({ sql, params }); },
  };
}

const ROW = {
  project_id: 123,
  title: 'Banner for Acme',
  employee_id: 12,
  first_name: 'Brady',
  last_name: 'Holm',
  phone_number: '519-555-0100',
};

test('sendJobMessageSms: happy path sends and logs one sms_log row', async () => {
  const db = fakeDb(ROW);
  const r = await sendJobMessageSms({ projectId: 123, message: '  Rush this one please  ', db });
  assert.equal(r.sent, true);
  assert.equal(r.employee_id, 12);
  assert.equal(r.employee_name, 'Brady Holm');
  assert.equal(db.inserts.length, 1);
  const [ins] = db.inserts;
  assert.match(ins.sql, /INSERT INTO sms_log/);
  assert.equal(ins.params[0], _internals.MESSAGE_KIND); // kind = 'job-message'
  assert.equal(ins.params[1], 12);                      // employee_id
  assert.equal(ins.params[2], 123);                     // project_id
  assert.equal(ins.params[5], true);                    // ok (stub counts as sent)
});

test('sendJobMessageSms: empty / whitespace-only message is rejected before any lookup', async () => {
  const db = fakeDb(ROW);
  for (const bad of ['', '   ', null, undefined, 42]) {
    const r = await sendJobMessageSms({ projectId: 123, message: bad, db });
    assert.equal(r.sent, false);
    assert.equal(r.reason, 'empty_message');
  }
  assert.equal(db.inserts.length, 0);
});

test('sendJobMessageSms: job with no assignee reports no_assignee', async () => {
  const db = fakeDb({ ...ROW, employee_id: null });
  const r = await sendJobMessageSms({ projectId: 123, message: 'hello', db });
  assert.equal(r.sent, false);
  assert.equal(r.reason, 'no_assignee');
  assert.equal(db.inserts.length, 0);
});

test('sendJobMessageSms: assignee without a phone reports no_phone with the name', async () => {
  const db = fakeDb({ ...ROW, phone_number: null });
  const r = await sendJobMessageSms({ projectId: 123, message: 'hello', db });
  assert.equal(r.sent, false);
  assert.equal(r.reason, 'no_phone');
  assert.equal(r.employee_name, 'Brady Holm');
  assert.equal(db.inserts.length, 0);
});

test('sendJobMessageSms: missing project reports project_not_found', async () => {
  const db = fakeDb(null);
  const r = await sendJobMessageSms({ projectId: 999, message: 'hello', db });
  assert.equal(r.sent, false);
  assert.equal(r.reason, 'project_not_found');
});
