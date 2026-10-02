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

// 50, 2.5 — never "50.000" from a NUMERIC column.
function formatQty(q) {
  const n = Number(q);
  if (!Number.isFinite(n)) return '';
  return Number.isInteger(n) ? String(n) : String(Number(n.toFixed(3)));
}

/**
 * "50 x Election signs, 100 x H-stakes" squeezed into `max` characters for
 * the reader's screen. Items that don't fit become "+2 more" rather than a
 * word cut in half, so the client can tell the list is longer.
 */
function itemsSummary(items, max = DESC_MAX) {
  const parts = (items || [])
    .filter((i) => i && String(i.description || '').trim())
    .map((i) => {
      const q = formatQty(i.qty);
      const d = clip(i.description, 40);
      return q && q !== '0' ? `${q} x ${d}` : d;
    });
  if (!parts.length) return '';
  for (let shown = parts.length; shown > 0; shown--) {
    const more = parts.length - shown;
    const s = parts.slice(0, shown).join(', ') + (more ? `, +${more} more` : '');
    if (s.length <= max) return s;
  }
  return clip(`${parts[0]}, +${parts.length - 1} more`, max);
}

// What the reader shows. Name first, then the pad — the client says who they
// are before they sign for it, the way a paper slip reads top to bottom.
// The pad lists what they're signing for (staff note first, then the items),
// so the client sees "25 of 50 signs" before they sign, not on the slip after.
function buildCollectInputs({ projectId, description, signatureId, items = [], note = '' }) {
  const n = clip(note, DESC_MAX);
  const list = itemsSummary(items, Math.max(0, DESC_MAX - (n ? n.length + 3 : 0)));
  const listed = [n, list].filter(Boolean).join(' · ');
  const what = description ? clip(description, DESC_MAX - 30) : 'your order';
  const sign = listed
    ? { title: 'Sign: received in good order', description: clip(listed, DESC_MAX) }
    : { title: 'Sign to confirm pickup', description: clip(`I have received ${what} in good order.`, DESC_MAX) };
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
          ...sign,
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

// Ontario HST — job line items are entered ex-tax (see lib/job-completion.js).
const HST = 0.13;

/**
 * Total / paid / balance for the slip. Pure, so it can be tested.
 *
 * The QuickBooks invoice wins when there is one: it knows about e-transfers
 * and cheques keyed in the office, which the counter tables never see. Counter
 * payments that haven't reached QuickBooks yet are taken off its balance so a
 * client who just paid at the till isn't shown as owing.
 *
 * With no invoice, the job's line items (grossed up for HST) less what the
 * counter has taken. Returns null for an unpriced job — no money section
 * beats a slip that says "$0.00 owing" on a job nobody has priced.
 */
function moneyFrom({ invoice = null, subtotalCents = 0, counterPaidCents = 0, unsyncedPaidCents = 0 }) {
  if (invoice?.found) {
    const total = invoice.totalCents || 0;
    const balance = Math.max(0, (invoice.balanceCents || 0) - unsyncedPaidCents);
    return { totalCents: total, paidCents: Math.max(0, total - balance), balanceCents: balance, source: 'invoice' };
  }
  if (!(subtotalCents > 0)) return null;
  const total = Math.round(subtotalCents * (1 + HST));
  const paid = Math.max(0, counterPaidCents);
  return { totalCents: total, paidCents: paid, balanceCents: Math.max(0, total - paid), source: 'job' };
}

/**
 * What the job holds right now: its items (staff-entered lines plus any
 * online-order lines) and its money. Copied onto the signature row when the
 * request goes out. Never throws on the QuickBooks side — a QBO outage just
 * means the counter numbers are used.
 */
async function jobSnapshot(projectId) {
  const { query } = require('../db/connection');
  const { invoiceSummaryForProject } = require('./qbo-terminal-writeback');

  const [lines, orderLines, totals, counter, invoice] = await Promise.all([
    query(`SELECT description, qty FROM items WHERE project_id = $1 ORDER BY id`, [projectId]),
    query(
      `SELECT CONCAT(oi.product_name, ' (', oi.color_name,
                     CASE WHEN COALESCE(oi.size, '') <> '' THEN ', ' || oi.size ELSE '' END, ')') AS description,
              oi.quantity AS qty
         FROM order_items oi JOIN orders o ON o.id = oi.order_id
        WHERE o.job_id = $1 ORDER BY oi.id`,
      [projectId]
    ),
    queryOne(
      `SELECT (SELECT COALESCE(SUM(ext_price), 0) FROM items WHERE project_id = $1)
            + (SELECT COALESCE(SUM(oi.line_subtotal), 0)
                 FROM order_items oi JOIN orders o ON o.id = oi.order_id
                WHERE o.job_id = $1) AS subtotal`,
      [projectId]
    ),
    queryOne(
      `SELECT COALESCE(SUM(paid), 0) AS paid, COALESCE(SUM(paid) FILTER (WHERE unsynced), 0) AS unsynced
         FROM (
           SELECT amount_cents - amount_refunded_cents AS paid, qbo_synced_at IS NULL AS unsynced
             FROM terminal_payments
            WHERE project_id = $1 AND status IN ('succeeded', 'partially_refunded', 'refunded')
           UNION ALL
           SELECT amount_cents, qbo_synced_at IS NULL
             FROM counter_offline_payments
            WHERE project_id = $1
         ) p`,
      [projectId]
    ),
    invoiceSummaryForProject(projectId),
  ]);

  const items = [...lines, ...orderLines]
    .filter((r) => String(r.description || '').trim())
    .map((r) => ({ description: String(r.description).trim(), qty: Number(r.qty) }));
  const money = moneyFrom({
    invoice,
    subtotalCents: Math.round(Number(totals?.subtotal || 0) * 100),
    counterPaidCents: Number(counter?.paid || 0),
    unsyncedPaidCents: Number(counter?.unsynced || 0),
  });
  return { items, money };
}

module.exports = {
  buildCollectInputs,
  itemsSummary,
  moneyFrom,
  jobSnapshot,
  readOutcome,
  settleFromReader,
  onReaderAction,
  _clip: clip,
};
