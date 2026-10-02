// routes/pickup-signatures.js
// Client signatures at pickup, on the counter's WisePOS E. Mounted at
// /api/pickup-signatures. Staff only.
//
// Flow: the job page POSTs here → the reader shows a name box and a
// signature pad → the page polls GET /:id until it settles → the page
// prints the pickup receipt with the signature on it. The webhook settles the
// row too (terminal.reader.action_*), so a page closed mid-signature still
// keeps the signature. See lib/pickup-signatures.js and migration 077.

'use strict';

const express = require('express');
const { query, queryOne } = require('../db/connection');
const { requireStaff } = require('../middleware/auth');
const { getStripe, stripeConfigured } = require('../lib/stripe-client');
const { buildCollectInputs, settleFromReader, jobSnapshot } = require('../lib/pickup-signatures');

const router = express.Router();

// Readers with a screen a client can sign on. The WisePad 3 has none.
const SMART_READERS = /^(bbpos_wisepos_e|stripe_s7\d\d|simulated_wisepos_e|simulated_stripe_s7\d\d)$/;

function requireStripe(req, res, next) {
  if (!stripeConfigured()) {
    return res.status(503).json({ error: 'Stripe is not configured on this server.' });
  }
  next();
}

const ROW_SELECT = `
  SELECT ps.*, CONCAT_WS(' ', e.first_name, e.last_name) AS requested_by
    FROM pickup_signatures ps
    LEFT JOIN employees e ON e.id = ps.requested_by_emp_id`;

function summary(row) {
  if (!row) return null;
  return {
    id:            row.id,
    projectId:     row.project_id,
    readerId:      row.reader_id,
    status:        row.status,          // pending | signed | failed | cancelled
    signerName:    row.signer_name,
    signatureSvg:  row.signature_svg,
    failureMessage: row.failure_message,
    requestedBy:   row.requested_by || null,
    note:          row.note || '',
    items:         row.items || [],
    // null when the job had no price on it at the time.
    money: row.total_cents == null ? null : {
      totalCents:   row.total_cents,
      paidCents:    row.paid_cents,
      balanceCents: row.balance_cents,
      source:       row.money_source,
    },
    createdAt:     row.created_at,
    signedAt:      row.signed_at,
  };
}

async function loadRow(id) {
  return queryOne(`${ROW_SELECT} WHERE ps.id = $1`, [id]);
}

// The page normally names the reader it has saved; a desk PC that has never
// picked one gets the shop's only online smart reader, which is what anyone
// would pick by hand.
async function chooseReader(stripe, readerId) {
  if (readerId) return stripe.terminal.readers.retrieve(readerId);
  const list = await stripe.terminal.readers.list({ limit: 20 });
  const smart = list.data.filter((r) => SMART_READERS.test(r.device_type));
  return smart.find((r) => r.status === 'online') || smart[0] || null;
}

// ─── GET /api/pickup-signatures?projectId=N ──────────────────────────────────
router.get('/', requireStaff, async (req, res) => {
  const projectId = Number.parseInt(req.query.projectId, 10);
  if (!Number.isInteger(projectId)) return res.status(400).json({ error: 'projectId is required' });
  try {
    const rows = await query(
      `${ROW_SELECT} WHERE ps.project_id = $1 AND ps.status = 'signed'
        ORDER BY ps.created_at DESC`,
      [projectId]
    );
    res.json(rows.map(summary));
  } catch (err) {
    console.error('[pickup-signatures] list:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ─── POST /api/pickup-signatures ─────────────────────────────────────────────
// { projectId, readerId?, note? } → puts the name box + signature pad on the reader.
router.post('/', requireStaff, requireStripe, async (req, res) => {
  const projectId = Number.parseInt(req.body?.projectId, 10);
  if (!Number.isInteger(projectId)) return res.status(400).json({ error: 'projectId is required' });

  try {
    const project = await queryOne(`SELECT id, description FROM projects WHERE id = $1`, [projectId]);
    if (!project) return res.status(404).json({ error: 'Job not found' });

    const stripe = getStripe();
    const reader = await chooseReader(stripe, req.body?.readerId || null);
    if (!reader) return res.status(503).json({ error: 'No card reader with a screen is set up.' });
    if (!SMART_READERS.test(reader.device_type)) {
      return res.status(400).json({ error: 'That card reader has no screen to sign on.' });
    }
    if (reader.status === 'offline') {
      return res.status(503).json({ error: `The card reader "${reader.label}" is offline.` });
    }
    // A sale in progress on the reader would be cancelled out from under the
    // customer by a new request. Refuse rather than guess.
    if (reader.action?.status === 'in_progress' && reader.action.type !== 'collect_inputs') {
      return res.status(409).json({ error: 'The card reader is in the middle of a payment. Try again when it is finished.' });
    }

    // Any older request still waiting on this reader is about to be replaced
    // on its screen; say so on its row rather than leave it pending forever.
    await query(
      `UPDATE pickup_signatures
          SET status = 'cancelled', failure_message = 'Replaced by a newer request', updated_at = NOW()
        WHERE reader_id = $1 AND status = 'pending'`,
      [reader.id]
    );

    // What's being signed for, frozen now so a reprint later matches what
    // the client saw on the reader.
    const note = String(req.body?.note || '').trim().slice(0, 500);
    const { items, money } = await jobSnapshot(projectId);

    const row = await queryOne(
      `INSERT INTO pickup_signatures
         (project_id, reader_id, requested_by_emp_id, note, items,
          total_cents, paid_cents, balance_cents, money_source)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING *`,
      [projectId, reader.id, req.user?.id || null, note || null, JSON.stringify(items),
       money?.totalCents ?? null, money?.paidCents ?? null, money?.balanceCents ?? null,
       money?.source ?? null]
    );

    try {
      await stripe.terminal.readers.collectInputs(
        reader.id,
        buildCollectInputs({ projectId, description: project.description, signatureId: row.id, items, note })
      );
    } catch (err) {
      await query(
        `UPDATE pickup_signatures SET status = 'failed', failure_message = $2, updated_at = NOW()
          WHERE id = $1`,
        [row.id, String(err.message).slice(0, 500)]
      );
      throw err;
    }

    res.json(summary(await loadRow(row.id)));
  } catch (err) {
    console.error('[pickup-signatures] request:', err.message);
    res.status(502).json({ error: err.message });
  }
});

// ─── GET /api/pickup-signatures/:id ──────────────────────────────────────────
// The page polls this. A pending row is checked against the reader each time.
router.get('/:id', requireStaff, async (req, res) => {
  const id = Number.parseInt(req.params.id, 10);
  if (!Number.isInteger(id)) return res.status(400).json({ error: 'Bad id' });
  try {
    let row = await loadRow(id);
    if (!row) return res.status(404).json({ error: 'Not found' });
    if (row.status === 'pending' && stripeConfigured()) {
      const stripe = getStripe();
      const reader = await stripe.terminal.readers.retrieve(row.reader_id);
      await settleFromReader(stripe, row, reader);
      row = await loadRow(id);
    }
    res.json(summary(row));
  } catch (err) {
    console.error('[pickup-signatures] status:', err.message);
    res.status(502).json({ error: err.message });
  }
});

// ─── POST /api/pickup-signatures/:id/cancel ──────────────────────────────────
// Staff backed out. Clears the reader's screen if it is still showing ours.
router.post('/:id/cancel', requireStaff, async (req, res) => {
  const id = Number.parseInt(req.params.id, 10);
  if (!Number.isInteger(id)) return res.status(400).json({ error: 'Bad id' });
  try {
    const row = await loadRow(id);
    if (!row) return res.status(404).json({ error: 'Not found' });
    if (row.status !== 'pending') return res.json(summary(row));

    if (stripeConfigured()) {
      const stripe = getStripe();
      try {
        const reader = await stripe.terminal.readers.retrieve(row.reader_id);
        const ours = reader.action?.type === 'collect_inputs'
          && reader.action.status === 'in_progress'
          && String(reader.action.collect_inputs?.metadata?.pickup_signature_id) === String(id);
        if (ours) await stripe.terminal.readers.cancelAction(row.reader_id);
      } catch (err) {
        // The reader may already be idle; the row still gets cancelled.
        console.warn('[pickup-signatures] cancel on reader:', err.message);
      }
    }
    await query(
      `UPDATE pickup_signatures SET status = 'cancelled', updated_at = NOW()
        WHERE id = $1 AND status = 'pending'`,
      [id]
    );
    res.json(summary(await loadRow(id)));
  } catch (err) {
    console.error('[pickup-signatures] cancel:', err.message);
    res.status(502).json({ error: err.message });
  }
});

module.exports = router;
