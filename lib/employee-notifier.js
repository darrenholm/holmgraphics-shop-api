// lib/employee-notifier.js
// Staff-facing notifications about jobs. Phase 1: text the employee assigned
// to a job when they become the assignee.
//
// Fires from every place production_emp_id gets set to someone:
//   * routes/orders.js  — online order auto-assigns to production (Brady)
//   * routes/designs.js — late-artwork promotion assigns to production
//   * routes/projects.js — staff create/reassign a job in the dashboard
//
// Idempotent per (project, employee): a given employee is texted at most once
// for a given job (sms_log unique index). Reassigning to someone new texts the
// new person; bouncing back to a prior assignee does not re-text them.
//
// Never throws — callers fire-and-forget after their DB writes are committed.

'use strict';

const sms = require('./sms');

const KIND = 'job-assigned';
const STAFF_BASE = (process.env.SHOP_STAFF_BASE || 'https://shop.holmgraphics.ca').replace(/\/$/, '');

// Format a projects.due_date (DATE → pg hands back a Date at UTC midnight) as
// a short "Thu Jul 3" without letting the local timezone roll it back a day.
const DOW = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
function formatDue(due) {
  if (!due) return null;
  const d = due instanceof Date ? due : new Date(due);
  if (isNaN(d.getTime())) return null;
  return `${DOW[d.getUTCDay()]} ${MON[d.getUTCMonth()]} ${d.getUTCDate()}`;
}

// Build the text body. Omits lines we have no data for so a job with no
// customer/due date still sends something clean.
function buildBody({ projectId, title, customerName, due }) {
  const lines = [`New job #${projectId}${title ? ': ' + title : ''}`];
  if (customerName) lines.push(`Customer: ${customerName}`);
  const dueStr = formatDue(due);
  if (dueStr) lines.push(`Due: ${dueStr}`);
  lines.push(`${STAFF_BASE}/jobs/${projectId}`);
  return lines.join('\n');
}

// sendJobAssignedSms({ projectId, db, orderId? })
//   projectId — projects.id whose current production_emp_id we notify.
//   db        — { query, queryOne } from db/connection.
//   orderId   — optional, recorded on the sms_log row for context.
//
// Returns { sent: bool, reason?: string }. Never throws.
async function sendJobAssignedSms({ projectId, db, orderId = null }) {
  if (projectId == null) return { sent: false, reason: 'no_project' };

  let row;
  try {
    row = await db.queryOne(
      `SELECT p.id                                   AS project_id,
              p.description                          AS title,
              p.due_date                             AS due,
              p.production_emp_id                    AS employee_id,
              e.first_name, e.last_name, e.phone_number,
              COALESCE(
                NULLIF(c.company, ''),
                NULLIF(TRIM(CONCAT_WS(' ', c.fname, c.lname)), '')
              )                                      AS customer_name
         FROM projects p
         LEFT JOIN employees e ON e.id = p.production_emp_id
         LEFT JOIN clients   c ON c.id = p.client_id
        WHERE p.id = $1`,
      [projectId]
    );
  } catch (err) {
    console.warn(`[employee-notifier] db lookup failed for project ${projectId}:`, err.message);
    return { sent: false, reason: 'db_error' };
  }

  if (!row) return { sent: false, reason: 'project_not_found' };
  if (!row.employee_id) return { sent: false, reason: 'no_assignee' };
  if (!row.phone_number) {
    console.log(`[employee-notifier] employee ${row.employee_id} has no phone_number; skipping job ${projectId}`);
    return { sent: false, reason: 'no_phone' };
  }

  // Early idempotency skip (the unique index is the race-safe backstop below).
  try {
    const already = await db.queryOne(
      `SELECT id FROM sms_log
        WHERE project_id = $1 AND employee_id = $2 AND kind = $3 AND ok = TRUE
        LIMIT 1`,
      [projectId, row.employee_id, KIND]
    );
    if (already) return { sent: false, reason: 'already_sent' };
  } catch (err) {
    // A read failure shouldn't block the send; the insert still guards dupes.
    console.warn(`[employee-notifier] sms_log precheck failed for project ${projectId}:`, err.message);
  }

  const body = buildBody({
    projectId: row.project_id,
    title: row.title,
    customerName: row.customer_name,
    due: row.due,
  });

  const result = await sms.send({
    to: row.phone_number,
    body,
    kind: KIND,
    refId: `job-${projectId}-emp-${row.employee_id}`,
  });

  try {
    await db.query(
      `INSERT INTO sms_log
         (kind, employee_id, project_id, order_id, to_number, provider, ok, message_id, error)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       ON CONFLICT (project_id, employee_id, kind) WHERE ok = TRUE DO NOTHING`,
      [
        KIND,
        row.employee_id,
        projectId,
        orderId,
        sms.toE164(row.phone_number),
        result.provider || (result.stub ? 'stub' : null),
        !!result.ok,
        result.message_id || null,
        result.ok ? null : (result.error || 'unknown'),
      ]
    );
  } catch (logErr) {
    if (logErr.code !== '23505') {
      console.warn(`[employee-notifier] sms_log insert failed for project ${projectId}:`, logErr.message);
    }
  }

  return result.ok
    ? { sent: true, employee_id: row.employee_id }
    : { sent: false, reason: 'send_failed', error: result.error };
}

const MESSAGE_KIND = 'job-message';

// sendJobMessageSms({ projectId, message, db })
//   Manual, staff-composed text to whoever is currently assigned to the job.
//   Repeatable — no dedupe (the sms_log unique index is scoped to
//   'job-assigned' as of migration 054). The message is prefixed with the
//   job number/title and suffixed with the job link so the employee has
//   context without opening the thread.
//
// Returns { sent: bool, to?, employee_id?, employee_name?, reason? }.
// Never throws.
async function sendJobMessageSms({ projectId, message, db }) {
  if (projectId == null) return { sent: false, reason: 'no_project' };
  const text = typeof message === 'string' ? message.trim() : '';
  if (!text) return { sent: false, reason: 'empty_message' };

  let row;
  try {
    row = await db.queryOne(
      `SELECT p.id                AS project_id,
              p.description       AS title,
              p.production_emp_id AS employee_id,
              e.first_name, e.last_name, e.phone_number
         FROM projects p
         LEFT JOIN employees e ON e.id = p.production_emp_id
        WHERE p.id = $1`,
      [projectId]
    );
  } catch (err) {
    console.warn(`[employee-notifier] db lookup failed for project ${projectId}:`, err.message);
    return { sent: false, reason: 'db_error' };
  }

  if (!row) return { sent: false, reason: 'project_not_found' };
  if (!row.employee_id) return { sent: false, reason: 'no_assignee' };
  const employeeName = [row.first_name, row.last_name].filter(Boolean).join(' ');
  if (!row.phone_number) {
    return { sent: false, reason: 'no_phone', employee_id: row.employee_id, employee_name: employeeName };
  }

  const body = [
    `Job #${row.project_id}${row.title ? ': ' + row.title : ''}`,
    text,
    `${STAFF_BASE}/jobs/${row.project_id}`,
  ].join('\n');

  const result = await sms.send({
    to: row.phone_number,
    body,
    kind: MESSAGE_KIND,
    refId: `job-${projectId}-emp-${row.employee_id}-msg`,
  });

  try {
    await db.query(
      `INSERT INTO sms_log
         (kind, employee_id, project_id, to_number, provider, ok, message_id, error)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [
        MESSAGE_KIND,
        row.employee_id,
        projectId,
        sms.toE164(row.phone_number),
        result.provider || (result.stub ? 'stub' : null),
        !!result.ok,
        result.message_id || null,
        result.ok ? null : (result.error || 'unknown'),
      ]
    );
  } catch (logErr) {
    console.warn(`[employee-notifier] sms_log insert failed for project ${projectId}:`, logErr.message);
  }

  return result.ok
    ? { sent: true, to: sms.toE164(row.phone_number), employee_id: row.employee_id, employee_name: employeeName }
    : { sent: false, reason: 'send_failed', error: result.error, employee_id: row.employee_id, employee_name: employeeName };
}

module.exports = { sendJobAssignedSms, sendJobMessageSms, _internals: { KIND, MESSAGE_KIND, buildBody, formatDue } };
