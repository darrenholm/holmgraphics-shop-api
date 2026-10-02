// lib/module-scan.test.js
//
// Run with:
//   node --test lib/module-scan.test.js
//
// The Claude call is faked: these pin how the request is built and how
// the answer is checked, not what Claude reads.

'use strict';

const test   = require('node:test');
const assert = require('node:assert/strict');
const { scanModulePhoto, normalizePartNo } = require('./module-scan');

function fakeClient(reply, capture = {}) {
  return {
    beta: { messages: { create: async (req) => {
      capture.req = req;
      return { model: 'claude-opus-5-5', usage: {}, ...reply };
    } } },
  };
}

const answer = (o) => ({
  stop_reason: 'end_turn',
  content: [{ type: 'text', text: JSON.stringify({
    sticker_number: 'UNKP8(5)2607A1J2628800199', board_model: 'P8-3535-40X20-A-5S-H-12V1.0',
    date_code: '26.10', legible: true, unsure: '', ...o,
  }) }],
});

test('normalizePartNo ignores case, spaces and bracket shape', () => {
  assert.equal(normalizePartNo(' unkp8{5}2607 a1j '), 'UNKP8(5)2607A1J');
  assert.equal(normalizePartNo('[5]'), '(5)');
  assert.equal(normalizePartNo(null), '');
});

test('sends the photo as a base64 image with a JSON schema', async () => {
  const cap = {};
  const r = await scanModulePhoto({
    imageBase64: 'data:image/jpeg;base64,QUJD', mediaType: 'image/jpeg',
    client: fakeClient(answer({}), cap),
  });
  const img = cap.req.messages[0].content[0];
  assert.equal(img.type, 'image');
  assert.equal(img.source.data, 'QUJD');           // data: prefix stripped
  assert.equal(cap.req.output_config.format.type, 'json_schema');
  assert.equal(cap.req.fallbacks, 'default');
  assert.equal(r.sticker_number, 'UNKP8(5)2607A1J2628800199');
  assert.equal(r.board_model, 'P8-3535-40X20-A-5S-H-12V1.0');
  assert.equal(r.legible, true);
});

test('rejects bad input before calling Claude', async () => {
  const client = { beta: { messages: { create: async () => { throw new Error('should not be called'); } } } };
  await assert.rejects(scanModulePhoto({ imageBase64: '', client }), { status: 400 });
  await assert.rejects(scanModulePhoto({ imageBase64: 'QUJD', mediaType: 'image/gif', client }), { status: 400 });
  await assert.rejects(scanModulePhoto({ imageBase64: 'A'.repeat(4_600_000), client }), { status: 413 });
});

test('a refusal or a non-JSON answer becomes a plain error', async () => {
  await assert.rejects(
    scanModulePhoto({ imageBase64: 'QUJD', client: fakeClient({ stop_reason: 'refusal', content: [] }) }),
    { status: 422, expose: true });
  await assert.rejects(
    scanModulePhoto({ imageBase64: 'QUJD', client: fakeClient({ stop_reason: 'end_turn', content: [{ type: 'text', text: 'nope' }] }) }),
    { status: 502, expose: true });
});

test('several angles go in one request and are read as one sticker', async () => {
  const cap = {};
  await scanModulePhoto({
    images: [{ imageBase64: 'QUJD' }, { imageBase64: 'data:image/jpeg;base64,REVG', mediaType: 'image/jpeg' }],
    client: fakeClient(answer({}), cap),
  });
  const content = cap.req.messages[0].content;
  assert.deepEqual(content.filter((b) => b.type === 'image').map((b) => b.source.data), ['QUJD', 'REVG']);
  assert.match(content.at(-1).text, /2 photos are the same LED module/);
  const client = { beta: { messages: { create: async () => { throw new Error('should not be called'); } } } };
  await assert.rejects(scanModulePhoto({ images: [1, 2, 3, 4].map(() => ({ imageBase64: 'QUJD' })), client }), { status: 400 });
  await assert.rejects(scanModulePhoto({ images: [{ imageBase64: 'QUJD' }, { imageBase64: '' }], client }), { status: 400 });
});
