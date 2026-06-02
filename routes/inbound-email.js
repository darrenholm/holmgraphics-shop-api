// routes/inbound-email.js
// Webhook that receives emails sent to *@reply.holmgraphics.ca and
// stores them as messages on the matching project. Triggered by the
// Cloudflare Email Worker living under cloudflare-worker/ — the worker
// reads the raw MIME, extracts plain-text body + headers, and POSTs
// here as JSON.
//
// Auth: shared secret in the `X-Inbound-Secret` header. Set
// INBOUND_EMAIL_SECRET on both Railway (this API) and Cloudflare (the
// Worker) to the same value. Without that env, the route refuses every
// request — better to fail closed than accept un-authenticated posts.
//
// Workflow on a valid hit:
//   1. Extract the job id from the To address (`...+job1234@reply...`
//      or bare `job1234@reply...`).
//   2. Dedupe by Message-ID — webhooks retry on 5xx so the same email
//      could land twice.
//   3. Identify sender: email matches a row in `employees` → it's a
//      staff forward (author_type='staff'); otherwise customer.
//   4. Strip the quoted-reply trail from the body.
//   5. Insert into project_messages.
//   6. Send a notification email to the OTHER party (so a customer
//      reply emails the assigned staff, and a staff forward emails the
//      customer's contact address).

'use strict';

const express = require('express');
const { query, queryOne } = require('../db/connection');
const { extractJobId, stripReplyTrail, parseFromHeader } = require('../lib/inbound-email-parser');
const mailer = require('../lib/customer-mailer');

const router = express.Router();

function requireInboundSecret(req, res, next) {
  const expected = process.env.INBOUND_EMAIL_SECRET;
  if (!expected) {
    console.warn('[inbound-email] INBOUND_EMAIL_SECRET not set — refusing request.');
    return res.status(503).json({ message: 'inbound email not configured' });
  }
  const provided = req.headers['x-inbound-secret'];
  if (provided !== expected) {
    return res.status(401).json({ message: 'invalid inbound secret' });
  }
  next();
}

// Body shape (from the Cloudflare Worker):
//   {
//     to:          string  (full To address)
//     from:        string  (raw From header)
//     subject:     string
//     text:        string  (plaintext body)
//     html:        string  (optional, ignored for now)
//     message_id:  string  (Message-ID header, used for dedup)
//   }
router.post('/projects/messages/inbound', express.json({ limit: '5mb' }), requireInboundSecret, async (req, res, next) => {
  try {
    const b = req.body || {};
    const to = String(b.to || '').trim();
    const fromRaw = String(b.from || '').trim();
    const subject = String(b.subject || '').trim();
    const textBody = String(b.text || '').trim();
    const messageId = b.message_id ? String(b.message_id).trim() : null;

    if (!to || !fromRaw || !textBody) {
      return res.status(400).json({ message: 'to, from, and text are required' });
    }

    const projectId = extractJobId(to);
    if (!projectId) {
      console.warn(`[inbound-email] no job id in To address: ${to}`);
      return res.status(400).json({ message: `address ${to} has no recognizable job tag` });
    }

    // Dedupe by Message-ID. If we already stored this exact email,
    // 200 OK so the webhook source stops retrying.
    if (messageId) {
      const existing = await queryOne(
        `SELECT id FROM project_messages WHERE inbound_message_id = $1`,
        [messageId]
      );
      if (existing) return res.json({ ok: true, deduped: true, project_message_id: existing.id });
    }

    // Verify the project exists.
    const proj = await queryOne(
      `SELECT p.id, p.description AS project_name,
              p.contact_email,
              c.email AS client_email,
              COALESCE(c.company, CONCAT_WS(' ', c.fname, c.lname)) AS client_name,
              e.email AS assigned_email,
              TRIM(CONCAT_WS(' ', e.first_name, e.last_name)) AS assigned_name
         FROM projects p
         LEFT JOIN clients   c ON c.id = p.client_id
         LEFT JOIN employees e ON e.id = p.production_emp_id
        WHERE p.id = $1`,
      [projectId]
    );
    if (!proj) {
      console.warn(`[inbound-email] job #${projectId} not found (To: ${to})`);
      return res.status(404).json({ message: `job #${projectId} not found` });
    }

    // Parse sender + classify as staff (forward) or customer (reply).
    const { name: fromName, email: fromEmail } = parseFromHeader(fromRaw);
    const employee = fromEmail
      ? await queryOne(`SELECT id, first_name, last_name FROM employees WHERE LOWER(email) = LOWER($1) LIMIT 1`, [fromEmail])
      : null;
    const isStaff = !!employee;

    const authorType = isStaff ? 'staff' : 'customer';
    const authorId   = isStaff ? employee.id : null;
    const authorName = isStaff
      ? `${employee.first_name || ''} ${employee.last_name || ''}`.trim() || 'Staff'
      : (fromName || fromEmail || 'Customer');

    // Strip quoted trail. If stripping leaves nothing (edge case where
    // the customer wrote only inline replies, or our heuristics over-
    // matched), fall back to the raw body — better to keep something
    // ugly than to drop the message.
    let body = stripReplyTrail(textBody);
    if (!body) body = textBody;

    // Insert as a message on the project.
    const inserted = await queryOne(
      `INSERT INTO project_messages
         (project_id, author_type, author_id, author_name, body,
          inbound_message_id, inbound_from_email)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING id, created_at`,
      [projectId, authorType, authorId, authorName, body, messageId, fromEmail || null]
    );

    // Mirror notification to the OTHER party so they hear about the
    // message in real time without polling the system.
    if (isStaff) {
      // Staff forwarded an email in → notify the customer.
      const customerEmail = (proj.contact_email && proj.contact_email.trim())
        || (proj.client_email && proj.client_email.trim())
        || null;
      if (customerEmail) {
        mailer.sendProjectMessageNotification({
          recipientEmail: customerEmail,
          audience:       'customer',
          projectId,
          projectName:    proj.project_name,
          authorName,
          body,
          replyToEmail:   (proj.assigned_email && proj.assigned_email.trim()) || null,
        }).catch((e) => console.warn('[inbound-email] customer notify failed:', e.message));
      }
    } else {
      // Customer replied → notify the assigned staff (or fall back to ops).
      const recipient = (proj.assigned_email && proj.assigned_email.trim()) || null;
      mailer.sendProjectMessageNotification({
        recipientEmail: recipient,
        audience:       'staff',
        projectId,
        projectName:    proj.project_name,
        authorName,
        body,
      }).catch((e) => console.warn('[inbound-email] staff notify failed:', e.message));
    }

    res.json({
      ok: true,
      project_id: projectId,
      project_message_id: inserted.id,
      author_type: authorType,
      created_at: inserted.created_at,
    });
  } catch (err) { next(err); }
});

module.exports = router;
