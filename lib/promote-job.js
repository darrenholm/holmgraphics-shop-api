// lib/promote-job.js
// Auto-promote an online order's project (job) to "Ordered" + assign it to
// production. Fires from POST /api/orders once the order has been charged
// and the placeholder design rows are inserted in the same transaction.
//
// Promotion rules (per docs/dtf-online-store-plan.md and the staff Kanban):
//   * production_emp_id is set to Brady Yzerman ONLY when currently NULL.
//     A staff manual reassignment is never overwritten.
//   * status_id is advanced to 2 ("Ordered") ONLY when currently NULL or 1
//     ("Quote"). A project that has already been advanced past Ordered
//     (e.g. status_id 3+) is never regressed.
//   * The update only fires when both order conditions are met:
//       - orders.paid_at IS NOT NULL
//       - at least one designs row exists for the order
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

async function maybePromoteJob(client, orderId) {
  if (!client || typeof client.query !== 'function') {
    throw new Error('maybePromoteJob: a pg client is required');
  }
  if (orderId == null) {
    throw new Error('maybePromoteJob: orderId is required');
  }

  // One round-trip to verify both promotion preconditions and resolve job_id.
  // EXISTS short-circuits — we don't care how many design rows there are.
  const check = await client.query(
    `SELECT o.job_id,
            (o.paid_at IS NOT NULL)                                  AS is_paid,
            EXISTS (SELECT 1 FROM designs d WHERE d.order_id = o.id) AS has_design
       FROM orders o
      WHERE o.id = $1`,
    [orderId]
  );
  if (check.rowCount === 0) {
    return { promoted: false, reason: 'order_not_found' };
  }
  const { job_id, is_paid, has_design } = check.rows[0];
  if (!is_paid)    return { promoted: false, reason: 'not_paid', job_id };
  if (!has_design) return { promoted: false, reason: 'no_designs', job_id };

  // Conditional UPDATE:
  //   * production_emp_id: COALESCE keeps any non-NULL existing value.
  //   * status_id: CASE only advances NULL/1 → 2; leaves 3+ alone.
  //   * The WHERE clause skips rows that already match the target state OR
  //     have a status further along than "Ordered" — making the call a
  //     no-op (zero rows updated) when nothing needs to change.
  const upd = await client.query(
    `UPDATE projects
        SET production_emp_id = COALESCE(production_emp_id, $2),
            status_id         = CASE
                                  WHEN status_id IS NULL OR status_id = $4
                                    THEN $3
                                  ELSE status_id
                                END,
            updated_at        = NOW()
      WHERE id = $1
        AND (
              production_emp_id IS NULL
           OR status_id IS NULL
           OR status_id = $4
            )
        AND (
              production_emp_id IS DISTINCT FROM $2
           OR status_id IS DISTINCT FROM $3
            )
      RETURNING id, production_emp_id, status_id`,
    [job_id, PRODUCTION_EMP_ID_BRADY, STATUS_ID_ORDERED, STATUS_ID_QUOTE]
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
  },
};
