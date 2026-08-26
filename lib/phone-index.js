// lib/phone-index.js
// Keeps client_phone_index (migration 057) in step with the two places a
// client's phone number is actually stored:
//
//   client_phones.number  — staff-entered contact list (main / mobile / fax)
//   clients.phone         — the single number the DTF-store signup captures
//
// Deliberately NO database trigger. The index is rebuilt for ONE client by
// calling syncClientPhoneIndex(clientId) from each write path. A trigger
// would have to re-implement the parse in plpgsql (it can't — libphonenumber
// lives in JS), and a trigger firing inside someone else's transaction is a
// much harder thing to debug at 9am when the pop shows the wrong name.
//
// Rebuild-from-scratch rather than diffing: a client has a handful of numbers,
// the DELETE+INSERT is two statements, and it self-heals rows that drifted.
//
// Failure policy: sync() NEVER throws. A phone number failing to index must
// not break saving a customer. Failures are logged and the index is simply
// stale for that client until the next save or the next backfill run.

'use strict';

const { query } = require('../db/connection');
const { toE164 } = require('./phone');

// Collect every (e164, label, source_field) triple for one client.
// Exported for the backfill script, which needs the same derivation but
// batches the reads instead of doing them per client.
function deriveIndexRows({ clientPhoneRows = [], clientPhone = null }) {
  const out = new Map(); // e164 → row, first source wins

  for (const r of clientPhoneRows) {
    const e164 = toE164(r.number);
    if (!e164) continue;
    if (out.has(e164)) continue;
    out.set(e164, {
      e164,
      label: r.phone_type || null,
      source_field: `client_phones.number#${r.id}`,
    });
  }

  const bare = toE164(clientPhone);
  if (bare && !out.has(bare)) {
    out.set(bare, { e164: bare, label: 'main', source_field: 'clients.phone' });
  }

  return [...out.values()];
}

// Rebuild the index rows for a single client. Returns the number of indexed
// numbers, or null if it failed (already logged).
async function syncClientPhoneIndex(clientId) {
  const id = parseInt(clientId, 10);
  if (!Number.isInteger(id)) return null;

  try {
    const [phoneRows, clientRows] = await Promise.all([
      query('SELECT id, number, phone_type FROM client_phones WHERE client_id = $1', [id]),
      query('SELECT phone FROM clients WHERE id = $1', [id]),
    ]);
    if (!clientRows[0]) return null; // client gone — the FK cascade handled it

    const rows = deriveIndexRows({
      clientPhoneRows: phoneRows,
      clientPhone: clientRows[0].phone,
    });

    await query('DELETE FROM client_phone_index WHERE client_id = $1', [id]);
    for (const r of rows) {
      await query(
        `INSERT INTO client_phone_index (client_id, e164, label, source_field)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (client_id, e164) DO NOTHING`,
        [id, r.e164, r.label, r.source_field]
      );
    }
    return rows.length;
  } catch (e) {
    console.error(`[phone-index] sync failed for client ${id}:`, e.message);
    return null;
  }
}

// Fire-and-forget wrapper for request handlers — the response should not wait
// on the index rebuild, and it must not turn an index failure into a 500 on
// an otherwise-successful save.
function syncClientPhoneIndexAsync(clientId) {
  syncClientPhoneIndex(clientId).catch(() => {});
}

module.exports = { syncClientPhoneIndex, syncClientPhoneIndexAsync, deriveIndexRows };
