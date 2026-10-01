'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { buildCollectInputs, readOutcome } = require('./pickup-signatures');

function reader(action) { return { id: 'tmr_1', action }; }
function collect(status, inputs = [], id = '7', extra = {}) {
  return {
    type: 'collect_inputs', status, ...extra,
    collect_inputs: { inputs, metadata: { pickup_signature_id: id } },
  };
}

test('request keeps the reader text inside its limits', () => {
  const body = buildCollectInputs({ projectId: 10070, description: 'x'.repeat(300), signatureId: 7 });
  assert.equal(body.inputs[0].type, 'text');
  assert.equal(body.inputs[1].type, 'signature');
  for (const i of body.inputs) {
    assert.ok(i.required);
    assert.ok(i.custom_text.title.length <= 40);
    assert.ok(i.custom_text.description.length <= 100);
  }
  assert.equal(body.metadata.pickup_signature_id, '7');
});

test('signed: name and file id come back', () => {
  const out = readOutcome(reader(collect('succeeded', [
    { type: 'text', text: { value: '  Pat Smith ' } },
    { type: 'signature', signature: { value: 'file_abc' } },
  ])), 7);
  assert.deepEqual(out, { state: 'signed', name: 'Pat Smith', fileId: 'file_abc' });
});

test('still on screen', () => {
  assert.equal(readOutcome(reader(collect('in_progress')), 7).state, 'pending');
});

test('timed out on the reader', () => {
  const out = readOutcome(reader(collect('failed', [], '7', { failure_message: 'Timed out' })), 7);
  assert.deepEqual(out, { state: 'failed', message: 'Timed out' });
});

test('reader moved on to a sale or a newer request', () => {
  assert.equal(readOutcome(reader({ type: 'process_payment_intent', status: 'in_progress' }), 7).state, 'superseded');
  assert.equal(readOutcome(reader(collect('in_progress', [], '8')), 7).state, 'superseded');
  assert.equal(readOutcome(reader(null), 7).state, 'superseded');
});

test('succeeded with no signature is a failure, not a blank signature', () => {
  const out = readOutcome(reader(collect('succeeded', [{ type: 'signature', skipped: true }])), 7);
  assert.equal(out.state, 'failed');
});
