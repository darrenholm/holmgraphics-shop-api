// lib/design-assistant.test.js
//
// Run with:
//   node --test lib/design-assistant.test.js
//
// The SVG sanitizer is the part worth pinning down: layouts are saved to L:
// and the Files panel opens them as blob URLs on the shop's own origin, so a
// script that slipped through would run with a staff session.

'use strict';

const test   = require('node:test');
const assert = require('node:assert/strict');
const da     = require('./design-assistant');
const { sanitizeSvg, buildJobContext, estimateCostUsd, runTurn } = da;
const { validateMessages, assetNames } = da._internals;

const box = (inner = '', attrs = 'viewBox="0 0 720 360"') =>
  `<svg ${attrs}>${inner}</svg>`;

test('sets physical size in inches and keeps the viewBox', () => {
  const out = sanitizeSvg(box('<rect width="10" height="10"/>', 'width="999" height="1" viewBox="0 0 720 360"'), 10, 5);
  assert.match(out, /^<svg width="10in" height="5in" viewBox="0 0 720 360" xmlns="http:\/\/www.w3.org\/2000\/svg">/);
  assert.equal((out.match(/width="10in"/g) || []).length, 1);
});

test('adds a viewBox when missing', () => {
  const out = sanitizeSvg('<svg><rect/></svg>', 96, 48);
  assert.match(out, /viewBox="0 0 6912 3456"/);
});

test('strips scripts, event handlers, foreignObject and javascript: links', () => {
  const evil = box(
    '<script>alert(1)</script><script src="x.js"/>' +
    '<rect onclick="steal()" onload=\'x()\' width="1"/>' +
    '<foreignObject><div>hi</div></foreignObject>' +
    '<a href="javascript:alert(1)"><text>t</text></a>' +
    '<iframe src="https://evil"></iframe>'
  );
  const out = sanitizeSvg(evil, 10, 5);
  assert.doesNotMatch(out, /script|onclick|onload|foreignObject|javascript|iframe/i);
  assert.match(out, /<rect width="1"\/>/);
});

test('keeps asset:, data:image and #fragment links, drops external ones', () => {
  const out = sanitizeSvg(box(
    '<image href="asset:Logo.png" width="5"/>' +
    '<image xlink:href="data:image/png;base64,AAAA"/>' +
    '<use href="#shape"/>' +
    '<image href="https://example.com/x.png"/>' +
    '<rect style="fill:url(https://evil/x)"/><rect style="fill:url(#grad)"/>'
  ), 10, 5);
  assert.match(out, /href="asset:Logo.png"/);
  assert.match(out, /xlink:href="data:image\/png;base64,AAAA"/);
  assert.match(out, /href="#shape"/);
  assert.doesNotMatch(out, /example\.com|evil/);
  assert.match(out, /url\(#grad\)/);
  assert.match(out, /xmlns:xlink=/);
});

test('removes xml prolog and DOCTYPE entities', () => {
  const out = sanitizeSvg('<?xml version="1.0"?><!DOCTYPE svg [<!ENTITY x "y">]><svg><text>&x;</text></svg>', 10, 5);
  assert.match(out, /^<svg /);
  assert.doesNotMatch(out, /DOCTYPE|ENTITY/);
});

test('rejects non-SVG and silly sizes', () => {
  assert.throws(() => sanitizeSvg('<html></html>', 10, 5), /not a complete SVG/);
  assert.throws(() => sanitizeSvg('<svg>', 10, 5), /not a complete SVG/);
  assert.throws(() => sanitizeSvg(box(), 0, 5), /out of range/);
  assert.throws(() => sanitizeSvg(box(), 5000, 5), /out of range/);
});

test('assetNames lists each placeholder once', () => {
  assert.deepEqual(
    assetNames('<image href="asset:a.png"/><image href=\'asset:b logo.png\'/><image href="asset:a.png"/>'),
    ['a.png', 'b logo.png']
  );
});

test('buildJobContext includes measurements, items, notes and files as data', () => {
  const ctx = buildJobContext({
    project: {
      id: 10020, project_name: 'Storefront sign', client_name: 'Acme',
      project_type: 'Signs', due_date: '2026-10-01T00:00:00Z',
      measurements: [{ item: 'Fascia', width: 144, height: 30, notes: 'above door' }],
    },
    items: [{ qty: 1, description: 'ACM panel 12x2.5' }],
    notes: [{ note: 'Client wants red', created_at: '2026-09-10T15:00:00Z' }],
    files: [{ name: 'logo.png' }],
  });
  assert.match(ctx, /^<job_record>/);
  assert.match(ctx, /Job #10020: Storefront sign/);
  assert.match(ctx, /Fascia: 144" wide × 30" high \(above door\)/);
  assert.match(ctx, /1 × ACM panel/);
  assert.match(ctx, /2026-09-10 Client wants red/);
  assert.match(ctx, /- logo\.png/);
});

test('estimateCostUsd uses Opus 5 list prices', () => {
  assert.equal(estimateCostUsd({ input_tokens: 1e6 }), 5);
  assert.equal(estimateCostUsd({ output_tokens: 1e6 }), 25);
  assert.equal(estimateCostUsd({ cache_read_input_tokens: 1e6, cache_creation_input_tokens: 1e6 }), 6.75);
});

test('validateMessages requires user first and last', () => {
  assert.throws(() => validateMessages([]), /non-empty/);
  assert.throws(() => validateMessages([{ role: 'assistant', content: 'x' }]), /start and end/);
  assert.throws(() => validateMessages([{ role: 'system', content: 'x' }]), /role/);
  validateMessages([{ role: 'user', content: 'hi' }]);
});

function fakeClient(responses) {
  const calls = [];
  return {
    calls,
    beta: { messages: { stream(params) {
      // Snapshot: runTurn keeps appending to the same history array.
      calls.push({ ...params, messages: params.messages.slice() });
      const msg = responses.shift();
      return { finalMessage: async () => msg };
    } } },
  };
}

test('runTurn collects layouts, answers tool calls, and returns appended history', async () => {
  const client = fakeClient([
    {
      model: 'claude-opus-5', stop_reason: 'tool_use',
      usage: { input_tokens: 1000, output_tokens: 2000 },
      content: [
        { type: 'text', text: 'Two options coming.' },
        { type: 'tool_use', id: 't1', name: 'create_layout',
          input: { title: 'Option A', width_in: 96, height_in: 48, svg: '<svg><image href="asset:logo.png"/></svg>', notes: '' } },
        { type: 'tool_use', id: 't2', name: 'create_layout',
          input: { title: 'Broken', width_in: 96, height_in: 48, svg: 'nope', notes: '' } },
      ],
    },
    {
      model: 'claude-opus-5', stop_reason: 'end_turn',
      usage: { input_tokens: 100, output_tokens: 50 },
      content: [{ type: 'text', text: 'Option A uses the logo large.' }],
    },
  ]);

  const out = await runTurn({
    messages: [{ role: 'user', content: 'Make a 4x8 sign' }],
    jobContext: '<job_record>x</job_record>',
    client,
  });

  assert.equal(out.layouts.length, 1);
  assert.equal(out.layouts[0].title, 'Option A');
  assert.deepEqual(out.layouts[0].assets, ['logo.png']);
  assert.match(out.layouts[0].svg, /width="96in"/);
  assert.equal(out.reply, 'Option A uses the logo large.');
  assert.equal(out.newMessages.length, 3);
  const toolTurn = out.newMessages[1];
  assert.equal(toolTurn.role, 'user');
  assert.equal(toolTurn.content[1].is_error, true);
  assert.equal(out.usage.output_tokens, 2050);

  // Second call sees the tool results appended, and every call carries the
  // job context as a cached system block plus fallbacks.
  assert.equal(client.calls[1].messages.length, 3);
  assert.equal(client.calls[0].system[1].text, '<job_record>x</job_record>');
  assert.equal(client.calls[0].fallbacks, 'default');
});
