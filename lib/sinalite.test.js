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
