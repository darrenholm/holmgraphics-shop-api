// lib/job-completion.js
//
// Moves a job to Complete once it has actually been paid off.
//
// Called from the Stripe webhook rather than the tablet, for the same reason
// the QuickBooks write-back is: the till can lose WiFi between "approved" on
// the reader and anything the app does afterwards, and a job silently left in
// Billing is exactly the kind of thing nobody notices for a week.
//
// ─── Why "fully paid" and not "any payment" ──────────────────────────────────
// A $500 deposit on a $2,000 sign is a counter payment too. Completing the job
// on the first PaymentIntent would close jobs that haven't been started, drop
// them off the active board, and stop the shop chasing the balance. So this
// only fires when the money taken covers the job.

'use strict';

const { query, queryOne } = require('../db/connection');

// projects.status_id — see the status lookup table.
const STATUS_COMPLETE = 11;
// Statuses that represent a deliberate human decision to park a job. Paying a
// job that someone has put on Hold should not quietly un-park it.
const STATUS_HOLD    = 12;
const STATUS_SERVICE = 13;

// Ontario HST, matching the rate used by the invoice and sales-receipt paths.
const HST = 0.13;

// Job line items are entered ex-tax; the counter charges tax-inclusive. The
// two are reconciled by grossing the job up rather than netting the payment
// down, so a job priced at a round number still matches to the cent.
//
// A few cents of slack absorbs the difference between the tablet's rounding
// and ours. Deliberately small: it must never let a genuinely short payment
// close a job.
const TOLERANCE_CENTS = 5;

/**
 * Decides whether a job is settled.
 *
 * Exported separately from the database work so the arithmetic — the part
 * that decides whether a real job closes — is testable on its own.
 *
 * @param {number} subtotalCents  job line items, ex-tax
 * @param {number} paidNetCents   succeeded payments less refunds
 */
function isFullyPaid(subtotalCents, paidNetCents) {
  if (!(subtotalCents > 0)) return false;      // nothing to measure against
  const owed = Math.round(subtotalCents * (1 + HST));
  return paidNetCents + TOLERANCE_CENTS >= owed;
}

/**
 * Completes `projectId` if counter payments now cover it.
 *
 * Idempotent and safe to call after every successful payment. Returns a small
 * object describing what it decided, so the webhook can log a reason rather
 * than just going quiet.
 */
async function completeIfFullyPaid(projectId, { employeeId = null } = {}) {
  if (!projectId) return { changed: false, reason: 'no job attached to this payment' };

  const project = await queryOne(
    `SELECT id, status_id FROM projects WHERE id = $1`,
    [projectId]
  );
  if (!project) return { changed: false, reason: `job #${projectId} not found` };

  if (project.status_id === STATUS_COMPLETE) {
    return { changed: false, reason: 'already Complete' };
  }
  if (project.status_id === STATUS_HOLD || project.status_id === STATUS_SERVICE) {
    return { changed: false, reason: `left on ${project.status_id === STATUS_HOLD ? 'Hold' : 'Service'} — someone parked it deliberately` };
  }

  // What the job is worth: staff-entered line items plus any online-order
  // lines attached to the same job. Mirrors what the job page totals, so the
  // number here is the number on screen.
  const totals = await queryOne(
    `SELECT
       (SELECT COALESCE(SUM(ext_price), 0) FROM items WHERE project_id = $1)
     + (SELECT COALESCE(SUM(oi.line_subtotal), 0)
          FROM order_items oi
          JOIN orders o ON o.id = oi.order_id
         WHERE o.job_id = $1) AS subtotal`,
    [projectId]
  );
  const subtotalCents = Math.round(Number(totals?.subtotal || 0) * 100);
  if (subtotalCents <= 0) {
    return { changed: false, reason: 'job has no priced line items to settle against' };
  }

  // What has actually been collected. Refunds count against it, so refunding
  // a completed job's payment and then re-running this won't re-complete it.
  const paidRow = await queryOne(
    `SELECT COALESCE(SUM(amount_cents - amount_refunded_cents), 0) AS paid
       FROM terminal_payments
      WHERE project_id = $1
        AND status IN ('succeeded', 'partially_refunded')`,
    [projectId]
  );
  const paidNetCents = Number(paidRow?.paid || 0);

  if (!isFullyPaid(subtotalCents, paidNetCents)) {
    const owed = Math.round(subtotalCents * (1 + HST));
    return {
      changed: false,
      reason: `part payment — $${(paidNetCents / 100).toFixed(2)} of $${(owed / 100).toFixed(2)}`,
      paidNetCents, owedCents: owed,
    };
  }

  await query(`UPDATE projects SET status_id = $1 WHERE id = $2`, [STATUS_COMPLETE, projectId]);

  // Same audit shape the staff-facing status route writes, so the job's
  // history reads consistently whether a person or a payment moved it.
  // employee_id is whoever took the payment at the counter.
  await query(
    `INSERT INTO audit_log
       (project_id, employee_id, field_changed, old_value, new_value, changed_at)
     VALUES ($1, $2, 'status_id', $3, $4, NOW())`,
    [
      projectId,
      employeeId,
      project.status_id != null ? String(project.status_id) : null,
      String(STATUS_COMPLETE),
    ]
  );

  return {
    changed: true,
    from: project.status_id,
    to: STATUS_COMPLETE,
    paidNetCents,
    owedCents: Math.round(subtotalCents * (1 + HST)),
  };
}

module.exports = {
  completeIfFullyPaid,
  isFullyPaid,
  STATUS_COMPLETE,
  _internals: { HST, TOLERANCE_CENTS, STATUS_HOLD, STATUS_SERVICE },
};
