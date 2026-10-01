// lib/pickup-signatures.js
// Client signatures at pickup, taken on the counter's WisePOS E.
//
// The reader does the asking (Stripe Terminal collect_inputs — no payment
// involved): a name box, then a signature pad. The outcome lands on the
// reader object as `action.collect_inputs`, which both the job page's poll
// (GET /api/pickup-signatures/:id) and the Stripe webhook read. Whichever
// gets there first records it; the other finds the row already settled.
//
// The signature itself comes back as a Stripe File (SVG) that Stripe deletes
// after 7 days, so it is copied into pickup_signatures.signature_svg the
// moment it's seen. See migration 077.

'use strict';

const { queryOne } = require('../db/connection');

// The reader's text limits: title 40, description 100 (non-selection).
const TITLE_MAX = 40;
const DESC_MAX  = 100;

function clip(s, n) {
  const t = String(s || '').replace(/\s+/g, ' ').trim();
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
}

// What the reader shows. Name first, then the pad — the client says who they
// are before they sign for it, the way a paper slip reads top to bottom.
function buildCollectInputs({ projectId, description, signatureId }) {
  const what = description ? clip(description, DESC_MAX - 30) : 'your order';
  return {
    inputs: [
      {
        type: 'text',
        required: true,
        custom_text: {
          title: clip(`Job #${projectId} pickup`, TITLE_MAX),
          description: 'Please type your name',
          submit_button: 'Next',
        },
      },
      {
        type: 'signature',
        required: true,
        custom_text: {
          title: 'Sign to confirm pickup',
          description: clip(`I have received ${what} in good order.`, DESC_MAX),
          submit_button: 'Done',
        },
      },
    ],
    metadata: {
      pickup_signature_id: String(signatureId),
      project_id: String(projectId),
    },
  };
}

/**
 * Reads what a reader says about one signature request. Pure, so it can be
 * tested without Stripe.
 *
 *   { state: 'pending' }                       still on the reader's screen
 *   { state: 'signed', name, fileId }          done
 *   { state: 'failed', message }               timed out / cancelled on the reader
 *   { state: 'superseded' }                    the reader has moved on to
 *                                              something else (a sale, a newer
 *                                              request) — this one is gone
 */
function readOutcome(reader, signatureId) {
  const a = reader?.action;
  const ours = a?.type === 'collect_inputs'
    && String(a.collect_inputs?.metadata?.pickup_signature_id || '') === String(signatureId);
  if (!ours) return { state: 'superseded' };

  if (a.status === 'in_progress') return { state: 'pending' };
  if (a.status === 'failed') {
    return { state: 'failed', message: a.failure_message || a.failure_code || 'Not signed' };
  }
  if (a.status !== 'succeeded') return { state: 'pending' };

  const inputs = a.collect_inputs?.inputs || [];
  const text = inputs.find((i) => i.type === 'text');
  const sig  = inputs.find((i) => i.type === 'signature');
  const fileId = sig?.signature?.value || null;
  if (!fileId) return { state: 'failed', message: 'The reader returned no signature' };
  return { state: 'signed', name: text?.text?.value?.trim() || null, fileId };
}

// The file's `url` needs the secret key, same as any API call.
async function downloadSvg(stripe, fileId) {
  const file = await stripe.files.retrieve(fileId);
  if (!file?.url) throw new Error(`Stripe file ${fileId} has no download URL`);
  const res = await fetch(file.url, {
    headers: { Authorization: `Bearer ${process.env.STRIPE_SECRET_KEY}` },
  });
  if (!res.ok) throw new Error(`Downloading signature ${fileId}: HTTP ${res.status}`);
  return res.text();
}

/**
 * Brings a pending row up to date from a reader object. Returns the row as
 * it now stands. Safe to call any number of times — only a 'pending' row is
 * ever changed, and the UPDATE says so, so a poll and a webhook racing each
 * other can't both write.
 */
async function settleFromReader(stripe, row, reader) {
  if (!row || row.status !== 'pending') return row;
  const out = readOutcome(reader, row.id);

  if (out.state === 'pending') return row;

  if (out.state === 'signed') {
    const svg = await downloadSvg(stripe, out.fileId);
    return (await queryOne(
      `UPDATE pickup_signatures
          SET status = 'signed', signer_name = $2, signature_svg = $3,
              stripe_file_id = $4, signed_at = NOW(), updated_at = NOW()
        WHERE id = $1 AND status = 'pending'
        RETURNING *`,
      [row.id, out.name, svg, out.fileId]
    )) || row;
  }

  const message = out.state === 'superseded'
    ? 'The card reader moved on to something else before this was signed'
    : out.message;
  return (await queryOne(
    `UPDATE pickup_signatures
        SET status = 'failed', failure_message = $2, updated_at = NOW()
      WHERE id = $1 AND status = 'pending'
      RETURNING *`,
    [row.id, String(message).slice(0, 500)]
  )) || row;
}

// Webhook entry: terminal.reader.action_succeeded / action_failed carry the
// reader object. Anything that isn't one of ours is ignored.
async function onReaderAction(stripe, reader) {
  if (reader?.action?.type !== 'collect_inputs') return null;
  const id = Number.parseInt(reader.action.collect_inputs?.metadata?.pickup_signature_id, 10);
  if (!Number.isInteger(id)) return null;
  const row = await queryOne(`SELECT * FROM pickup_signatures WHERE id = $1`, [id]);
  return settleFromReader(stripe, row, reader);
}

module.exports = {
  buildCollectInputs,
  readOutcome,
  settleFromReader,
  onReaderAction,
  _clip: clip,
};
