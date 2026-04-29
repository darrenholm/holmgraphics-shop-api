// lib/promote-job.js
// Auto-promote an online order's project (job) to "Ordered" + assign it to
// production. Fires from POST /api/orders once the order has been charged
// (and the placeholder design rows are inserted in the same transaction),
// and again from POST /api/designs/:id/upload after artwork is attached
// (the late-artwork case — see fix/online-order-finishing-touches).
//
// Promotion rules (per docs/dtf-online-store-plan.md and the staff Kanban):
//   * production_emp_id is set to Brady Yzerman ONLY when currently NULL.
//     A staff manual reassignment is never overwritten.
//   * status_id is advanced to 2 ("Ordered") ONLY when currently NULL or 1
//     ("Quote"). A project that has already been advanced past Ordered
//     (e.g. status_id 3+) is never regressed.
//   * description (the dashboard's job-title column) is set to
//     "{recipient_name}-Online" ONLY when currently NULL or empty/whitespace.
//     A staff manual rename is never overwritten.
//   * The update fires when the order is paid AND either
//       - at least one designs row exists, OR
//       - the order has no decorations (a $0-decoration garment-only order
//         never gets a design row, so waiting on one would strand it
//         forever in status_id 1).
//
// Idempotent: safe to call repeatedly. The WHERE clause guards against
// redundant UPDATEs when no column needs changing.
//
// The caller passes its own pg client so this work joins the caller's
// transaction; the caller owns BEGIN/COMMIT/ROLLBACK.

'use strict';

// Brady Yzerman — production lead. Hard-coded per the current job-board
// convention; revisit when adding multi-employee load balancing.
const PRODUCTION_EMP_ID_BRADY = 12;

// status table FKs. Mirror the seed data in the projects status lookup.
const STATUS_ID_QUOTE   = 1;
const STATUS_ID_ORDERED = 2;

// Recipient-name fallback when ship_to_name is missing AND the client has
// no company / first / last name on file. Vanishingly rare for online
// orders (account creation requires fname+lname) but kept so the SQL
// never produces a literal "null-Online" job title.
const RECIPIENT_FALLBACK = 'Online customer';

async function maybePromoteJob(client, orderId) {
  if (!client || typeof client.query !== 'function') {
    throw new Error('maybePromoteJob: a pg client is required');
  }
  if (orderId == null) {
    throw new Error('maybePromoteJob: orderId is required');
  }

  // One round-trip to verify all promotion preconditions and resolve job_id +
  // recipient_name. EXISTS short-circuits — we don't care how many design or
  // decoration rows there are, only whether any exist.
  const check = await client.query(
    `SELECT o.job_id,
            (o.paid_at IS NOT NULL)                                          AS is_paid,
            EXISTS (SELECT 1 FROM designs           d  WHERE d.order_id  = o.id) AS has_design,
            EXISTS (SELECT 1 FROM order_decorations od WHERE od.order_id = o.id) AS has_decorations,
            COALESCE(
              CASE WHEN o.fulfillment_method = 'ship'
                THEN NULLIF(o.ship_to_name, '')
              END,
              NULLIF(c.company, ''),
              NULLIF(TRIM(CONCAT_WS(' ', c.fname, c.lname)), ''),
              $2
            ) AS recipient_name
       FROM orders o
       JOIN clients c ON c.id = o.client_id
      WHERE o.id = $1`,
    [orderId, RECIPIENT_FALLBACK]
  );
  if (check.rowCount === 0) {
    return { promoted: false, reason: 'order_not_found' };
  }
  const { job_id, is_paid, has_design, has_decorations, recipient_name } = check.rows[0];
  if (!is_paid) return { promoted: false, reason: 'not_paid', job_id };
  // A decorated order must have at least one design row before we promote.
  // An order with NO decorations (e.g. blank-garment-only purchase) never
  // gets a design row, so waiting on one would strand it forever — promote.
  if (!has_design && has_decorations) {
    return { promoted: false, reason: 'no_designs', job_id };
  }

  const projectName = `${recipient_name}-Online`;

  // Conditional UPDATE:
  //   * production_emp_id: COALESCE keeps any non-NULL existing value.
  //   * status_id: CASE only advances NULL/1 → 2; leaves 3+ alone.
  //   * description: CASE only sets when currently NULL or whitespace —
  //     never overwrites a staff-edited title.
  //   * The WHERE clause skips rows whose every guarded field is already
  //     populated, making this a true no-op (zero rows updated) when
  //     nothing needs to change.
  const upd = await client.query(
    `UPDATE projects
        SET production_emp_id = COALESCE(production_emp_id, $2),
            status_id         = CASE
                                  WHEN status_id IS NULL OR status_id = $4
                                    THEN $3
                                  ELSE status_id
                                END,
            description       = CASE
                                  WHEN description IS NULL OR TRIM(description) = ''
                                    THEN $5
                                  ELSE description
                                END,
            updated_at        = NOW()
      WHERE id = $1
        AND (
              production_emp_id IS NULL
           OR status_id IS NULL
           OR status_id = $4
           OR description IS NULL
           OR TRIM(description) = ''
            )
      RETURNING id, production_emp_id, status_id, description`,
    [job_id, PRODUCTION_EMP_ID_BRADY, STATUS_ID_ORDERED, STATUS_ID_QUOTE, projectName]
  );

  if (upd.rowCount === 0) {
    return { promoted: false, reason: 'no_change_needed', job_id };
  }
  return {
    promoted: true,
    job_id,
    project: upd.rows[0],
  };
}

module.exports = {
  maybePromoteJob,
  // exported for tests
  _internals: {
    PRODUCTION_EMP_ID_BRADY,
    STATUS_ID_QUOTE,
    STATUS_ID_ORDERED,
    RECIPIENT_FALLBACK,
  },
};
