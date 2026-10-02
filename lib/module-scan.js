// lib/module-scan.js
// Reads the sticker on an LED module from a phone photo, for the
// "Scan sticker" button on the /modules page.
//
// One Claude vision call with a JSON schema for the answer. Claude only
// transcribes; matching the number against the inventory happens in the
// route, in SQL, so a misread can never silently attach to the wrong row.
//
// Public surface:
//   scanModulePhoto({ images: [{ imageBase64, mediaType }], client? })
//     (or a single { imageBase64, mediaType }) — several photos are the same
//     sticker from different angles, e.g. when a frame rib covers part of it
//     → { sticker_number, board_model, date_code, legible, unsure, model, usage }
//   normalizePartNo(s)   — the comparison key the route matches on
//   isConfigured()
//
// Requires ANTHROPIC_API_KEY (same key the Design Assistant uses).

'use strict';

const Anthropic = require('@anthropic-ai/sdk');

const MODEL = process.env.MODULE_SCAN_MODEL || 'claude-opus-5-5';

const MEDIA_TYPES = ['image/jpeg', 'image/png', 'image/webp'];
const MAX_BASE64_CHARS = 4_500_000; // ~3.3 MB image; the phone resizes first
const MAX_IMAGES = 3;

let _client = null;
function defaultClient() {
  if (!_client) {
    if (!process.env.ANTHROPIC_API_KEY) {
      throw new Error('Sticker scan not configured: set ANTHROPIC_API_KEY');
    }
    _client = new Anthropic();
  }
  return _client;
}

function isConfigured() {
  return !!process.env.ANTHROPIC_API_KEY;
}

// Case, spaces, and the round/curly bracket confusion on these printed
// stickers ("UNKP8(5)" vs "UNKP8{5}") are not meaningful differences.
function normalizePartNo(s) {
  return String(s ?? '')
    .toUpperCase()
    .replace(/[{[]/g, '(')
    .replace(/[}\]]/g, ')')
    .replace(/\s+/g, '');
}

const SYSTEM = `You read the identification printed on LED display modules from phone photos taken in a sign shop's storage room. Staff use what you return as the module's part number in their inventory, so an exact transcription matters more than a complete one.

Two things are usually visible:
- sticker_number: the code on the white or silver sticker, for example "UNKP8(5)2607A1J2628800199". Copy every character exactly, including brackets and their position.
- board_model: the model code printed in white on the circuit board itself, for example "P8-3535-40X20-A-5S-H-12V1.0". If the start or end runs off the edge of the photo, return only what is visible and say so in unsure.
- date_code: a short code printed on the board near the model, such as "26.10", if there is one.

Sometimes a frame rib or a component covers part of the sticker, and staff send two or three photos of the same module from different angles. Treat them as one sticker: line the visible pieces up by the characters they share and give one combined reading. Only use "?" where no photo shows the character, and if the pieces don't overlap enough to know how many characters are hidden between them, say so in unsure.

Photos are often taken through shrink wrap, with glare and at an angle. If any character is hidden or could be two different things (0/O, 1/I, 5/S, 8/B), put "?" in its place and explain in unsure which position and what the options are. Never guess a hidden character. Use an empty string for anything not in the photo. Set legible to false if no sticker number can be read at all.`;

const SCHEMA = {
  type: 'object',
  properties: {
    sticker_number: { type: 'string', description: 'Exact sticker text, "?" for unreadable characters, "" if none.' },
    board_model:    { type: 'string', description: 'Model code printed on the board, "" if none.' },
    date_code:      { type: 'string', description: 'Date code printed on the board, "" if none.' },
    legible:        { type: 'boolean', description: 'False when no sticker number can be read.' },
    unsure:         { type: 'string', description: 'Plain-language note on any doubtful or cut-off characters, "" if none.' },
  },
  required: ['sticker_number', 'board_model', 'date_code', 'legible', 'unsure'],
  additionalProperties: false,
};

function checkImage({ imageBase64, mediaType = 'image/jpeg' } = {}) {
  if (!MEDIA_TYPES.includes(mediaType)) {
    throw Object.assign(new Error('Photo must be JPEG, PNG or WEBP'), { status: 400, expose: true });
  }
  const data = String(imageBase64 || '').replace(/^data:image\/\w+;base64,/, '');
  if (!data) throw Object.assign(new Error('No photo received'), { status: 400, expose: true });
  if (data.length > MAX_BASE64_CHARS) {
    throw Object.assign(new Error('Photo is too large'), { status: 413, expose: true });
  }
  return { type: 'image', source: { type: 'base64', media_type: mediaType, data } };
}

async function scanModulePhoto({ images, imageBase64, mediaType, client } = {}) {
  const list = Array.isArray(images) && images.length ? images : [{ imageBase64, mediaType }];
  if (list.length > MAX_IMAGES) {
    throw Object.assign(new Error(`At most ${MAX_IMAGES} photos per scan`), { status: 400, expose: true });
  }
  const blocks = list.map(checkImage);

  const c = client || defaultClient();
  const msg = await c.beta.messages.create({
    model: MODEL,
    max_tokens: 16000,
    betas: ['server-side-fallback-2026-07-01'],
    fallbacks: 'default',
    output_config: { effort: 'medium', format: { type: 'json_schema', schema: SCHEMA } },
    system: SYSTEM,
    messages: [{
      role: 'user',
      content: [
        ...blocks,
        { type: 'text', text: blocks.length > 1
          ? `These ${blocks.length} photos are the same LED module from different angles. Read it.`
          : 'Read this LED module.' },
      ],
    }],
  });

  if (msg.stop_reason === 'refusal') {
    throw Object.assign(new Error('The photo could not be read. Try another photo.'), { status: 422, expose: true });
  }
  if (msg.stop_reason === 'max_tokens') {
    throw Object.assign(new Error('The reader ran out of room. Try again.'), { status: 502, expose: true });
  }
  const text = msg.content.filter((b) => b.type === 'text').map((b) => b.text).join('');
  let out;
  try { out = JSON.parse(text); } catch {
    throw Object.assign(new Error('The reader returned an unexpected answer. Try again.'), { status: 502, expose: true });
  }

  return {
    sticker_number: String(out.sticker_number || '').trim(),
    board_model:    String(out.board_model || '').trim(),
    date_code:      String(out.date_code || '').trim(),
    legible:        !!out.legible,
    unsure:         String(out.unsure || '').trim(),
    model:          msg.model || MODEL,
    usage:          msg.usage,
  };
}

module.exports = { scanModulePhoto, normalizePartNo, isConfigured, MODEL, MAX_IMAGES };
