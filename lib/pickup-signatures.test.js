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

const { itemsSummary, moneyFrom } = require('./pickup-signatures');

test('items list on the reader: quantities, and "+N more" when it runs long', () => {
  assert.equal(itemsSummary([{ description: 'Election signs 18x24', qty: '50.000' }, { description: 'H-stakes', qty: 100 }]),
    '50 x Election signs 18x24, 100 x H-stakes');
  const many = Array.from({ length: 12 }, (_, i) => ({ description: `Sign panel number ${i + 1}`, qty: 2 }));
  const s = itemsSummary(many);
  assert.ok(s.length <= 100, s);
  assert.match(s, /\+\d+ more$/);
  assert.equal(itemsSummary([]), '');
});

test('reader pad shows the note and items when there are some', () => {
  const body = buildCollectInputs({
    projectId: 10066, description: 'Election signs', signatureId: 9,
    items: [{ description: 'Coroplast signs', qty: 50 }], note: '25 of 50, rest Friday',
  });
  const pad = body.inputs[1].custom_text;
  assert.equal(pad.description, '25 of 50, rest Friday · 50 x Coroplast signs');
  assert.ok(pad.title.length <= 40);
  const long = buildCollectInputs({ projectId: 1, signatureId: 1, note: 'n'.repeat(400), items: [{ description: 'x', qty: 1 }] });
  assert.ok(long.inputs[1].custom_text.description.length <= 100);
});

test('money: invoice wins, less counter payments not yet in QuickBooks', () => {
  assert.deepEqual(
    moneyFrom({ invoice: { found: true, totalCents: 11300, balanceCents: 11300 }, unsyncedPaidCents: 5000 }),
    { totalCents: 11300, paidCents: 5000, balanceCents: 6300, source: 'invoice' });
});

test('money: no invoice → job lines plus HST, less counter payments', () => {
  assert.deepEqual(moneyFrom({ subtotalCents: 10000, counterPaidCents: 2000 }),
    { totalCents: 11300, paidCents: 2000, balanceCents: 9300, source: 'job' });
  assert.equal(moneyFrom({ subtotalCents: 0 }), null);
});
