// lib/client-notifier.js
// Client-facing notifications about their job. Phase 1: "your job is ready for
// pickup", fired by the staff "Notify ready for pickup" button on the job card
// (routes/projects.js → POST /api/projects/:id/notify-ready).
//
// Sends over whichever channels the caller asks for AND the client has on file:
//   * email → lib/customer-mailer.js sendProjectReadyForPickup, logged to email_log
//   * text  → lib/sms.js send(),                                logged to sms_log
//
// Contact resolution prefers the PROJECT-level contact (the person for this
// specific job) and falls back to the client account's email/phone.
//
// Manual + repeatable: staff may legitimately re-send (customer didn't show),
// so nothing here dedupes — every attempt is logged for audit.
//
// Never throws — the route awaits the summary and reports it back to staff.

'use strict';

const sms    = require('./sms');
const mailer = require('./customer-mailer');

const SMS_KIND   = 'client-job-ready';
const EMAIL_KIND = 'project-ready-for-pickup';

// Pickup details for the SMS body. Mirrors the constants in customer-mailer.js
// (kept in sync with [[holmgraphics_constants]] — pickup address + phone).
const PICKUP_ADDR = '2-43 Eastridge Rd, Walkerton ON N0G 2V0';
const PHONE       = '519-507-3001';

function firstName(name) {
  if (!name) return '';
  return String(name).trim().split(/\s+/)[0] || '';
}

function buildSmsBody({ projectName, contactName }) {
  const who   = contactName ? `Hi ${contactName}, ` : '';
  const title = projectName ? `"${projectName}"` : 'your order';
  return `${who}${title} is ready for pickup at Holm Graphics — ${PICKUP_ADDR}. Mon-Fri 9-5. Questions? ${PHONE}`;
}

// sendJobReadyNotifications({ projectId, db, email?, sms? })
//   projectId — projects.id
//   db        — { query, queryOne }
//   email     — attempt the email channel (default true)
//   sms       — attempt the text channel (default true)
//
// Returns { email?: {sent, to?, reason?, error?}, sms?: {…}, error? }. Never throws.
async function sendJobReadyNotifications({ projectId, db, email = true, sms: doSms = true }) {
  if (projectId == null) return { error: 'no_project' };

  let row;
  try {
    row = await db.queryOne(
      `SELECT p.id,
              p.description  AS project_name,
              p.client_id,
              p.contact_name,
              p.contact_email,
              p.contact_phone,
              c.email        AS client_email,
              c.phone        AS client_phone,
              COALESCE(
                NULLIF(p.contact_name, ''),
                NULLIF(TRIM(CONCAT_WS(' ', c.fname, c.lname)), ''),
                NULLIF(c.company, '')
              )              AS display_name
         FROM projects p
         LEFT JOIN clients c ON c.id = p.client_id
        WHERE p.id = $1`,
      [projectId]
    );
  } catch (err) {
    console.warn(`[client-notifier] db lookup failed for project ${projectId}:`, err.message);
    return { error: 'db_error' };
  }
  if (!row) return { error: 'project_not_found' };

  const toEmail = (row.contact_email || row.client_email || '').trim();
  const toPhone = (row.contact_phone || row.client_phone || '').trim();
  const name    = firstName(row.display_name);
  const out = {};

  if (email) {
    if (!toEmail) {
      out.email = { sent: false, reason: 'no_email' };
    } else {
      let r;
      try {
        r = await mailer.sendProjectReadyForPickup({
          email: toEmail, projectName: row.project_name, contactName: name,
        });
      } catch (err) {
        r = { ok: false, error: err.message };
      }
      try {
        await db.query(
          `INSERT INTO email_log (order_id, project_id, kind, ok, message_id, error)
                VALUES (NULL, $1, $2, $3, $4, $5)`,
          [projectId, EMAIL_KIND, !!r.ok, r.message_id || null, r.ok ? null : (r.error || 'unknown')]
        );
      } catch (logErr) {
        console.warn(`[client-notifier] email_log insert failed for project ${projectId}:`, logErr.message);
      }
      out.email = r.ok
        ? { sent: true, to: toEmail }
        : { sent: false, reason: 'send_failed', error: r.error, to: toEmail };
    }
  }

  if (doSms) {
    if (!toPhone) {
      out.sms = { sent: false, reason: 'no_phone' };
    } else {
      const body = buildSmsBody({ projectName: row.project_name, contactName: name });
      const r = await sms.send({ to: toPhone, body, kind: SMS_KIND, refId: `job-${projectId}-ready` });
      try {
        await db.query(
          `INSERT INTO sms_log
             (kind, employee_id, client_id, project_id, order_id, to_number, provider, ok, message_id, error)
           VALUES ($1, NULL, $2, $3, NULL, $4, $5, $6, $7, $8)`,
          [
            SMS_KIND,
            row.client_id,
            projectId,
            sms.toE164(toPhone),
            r.provider || (r.stub ? 'stub' : null),
            !!r.ok,
            r.message_id || null,
            r.ok ? null : (r.error || 'unknown'),
          ]
        );
      } catch (logErr) {
        console.warn(`[client-notifier] sms_log insert failed for project ${projectId}:`, logErr.message);
      }
      out.sms = r.ok
        ? { sent: true, to: sms.toE164(toPhone) }
        : { sent: false, reason: r.error === 'invalid_destination' ? 'invalid_phone' : 'send_failed', error: r.error, to: toPhone };
    }
  }

  return out;
}

module.exports = { sendJobReadyNotifications, _internals: { buildSmsBody, firstName, SMS_KIND, EMAIL_KIND } };
