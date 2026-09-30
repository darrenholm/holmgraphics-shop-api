'use strict';

const test = require('node:test');
const assert = require('node:assert');
const {
  groupOptions, parseProductDetail, parseShipping, optionsByGroup,
} = require('../suppliers/sinalite/client');

test('groupOptions puts qty first, turnaround last, sorts qty numerically', () => {
  const g = groupOptions([
    { id: 5, group: 'qty', name: '50' },
    { id: 140, group: 'Turnaround', name: '2 - 3 Business Days' },
    { id: 141, group: 'qty', name: '10' },
    { id: 447, group: 'Stock', name: 'Brown Cardboard' },
    { id: 277, group: 'qty', name: '5' },
  ]);
  assert.deepStrictEqual(g.map((x) => x.group), ['qty', 'Stock', 'Turnaround']);
  assert.deepStrictEqual(g[0].options.map((o) => o.name), ['5', '10', '50']);
});

test('parseProductDetail reads the three-array response', () => {
  const d = parseProductDetail([
    [{ id: 1, group: 'size', name: '2 x 3.5' }],
    [{ hash: 'abc', value: '1' }],
    [{ metadata: 'custom_size' }, { metadata: 'shapes' }],
  ]);
  assert.strictEqual(d.groups.length, 1);
  assert.deepStrictEqual(d.metadata, ['custom_size', 'shapes']);
});

test('parseShipping turns rows into objects, cheapest first', () => {
  const r = parseShipping({
    statusCode: 200,
    body: [['UPS', 'UPS Express', 23.58, 1], ['UPS', 'UPS Standard', 9.1, 1]],
  });
  assert.deepStrictEqual(r[0], { carrier: 'UPS', method: 'UPS Standard', price: 9.1, days: 1 });
  assert.strictEqual(r.length, 2);
});

test('optionsByGroup maps chosen ids to { group: "id" }', () => {
  const groups = groupOptions([
    { id: 5, group: 'qty', name: '50' },
    { id: 141, group: 'qty', name: '10' },
    { id: 447, group: 'Stock', name: 'Brown Cardboard' },
  ]);
  assert.deepStrictEqual(optionsByGroup(groups, [141, 447]), { qty: '141', Stock: '447' });
});

const files = require('../suppliers/sinalite/files');

test('safeName keeps names readable and URL-safe', () => {
  assert.strictEqual(files.safeName('Smith Cards FRONT.pdf'), 'Smith-Cards-FRONT.pdf');
  assert.strictEqual(files.safeName('../../etc/passwd'), 'passwd.pdf');
  assert.strictEqual(files.safeName(''), 'file.pdf');
});

test('looksLikePdf spots real PDFs and rejects renamed images', () => {
  assert.ok(files.looksLikePdf(Buffer.from('%PDF-1.7\n...')));
  assert.ok(!files.looksLikePdf(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a])));
});

test('absPath refuses to leave the files folder', () => {
  assert.throws(() => files.absPath('../../secret'));
  assert.ok(files.absPath('ab/abc.pdf').endsWith('abc.pdf'));
});

test('webhook secret is derived from the client secret and checked exactly', () => {
  const before = process.env.SINALITE_CLIENT_SECRET;
  process.env.SINALITE_CLIENT_SECRET = 'test-secret';
  const url = files.webhookUrl();
  const secret = url.split('/').pop();
  assert.match(secret, /^[a-f0-9]{32}$/);
  assert.ok(files.secretMatches(secret));
  assert.ok(!files.secretMatches(secret.replace(/.$/, secret.endsWith('0') ? '1' : '0')));
  assert.ok(!files.secretMatches(undefined));
  if (before === undefined) delete process.env.SINALITE_CLIENT_SECRET; else process.env.SINALITE_CLIENT_SECRET = before;
});
