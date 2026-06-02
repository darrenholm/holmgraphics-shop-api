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
const crypto = require('crypto');
const { query, queryOne } = require('../db/connection');
const { extractJobId, stripReplyTrail, parseFromHeader } = require('../lib/inbound-email-parser');
const mailer = require('../lib/customer-mailer');

const router = express.Router();

// Auth: accept EITHER a shared-secret header (for the Cloudflare
// Email Worker path or curl testing) OR a Svix-style signature header
// (for Resend Inbound). Whichever env is set determines which check
// runs; both can be set side-by-side. If neither is set the route
// refuses every request — better fail-closed than allow un-authed posts.
function verifyInboundAuth(req, res, next) {
  const sharedSecret = process.env.INBOUND_EMAIL_SECRET;       // X-Inbound-Secret header
  const svixSecret   = process.env.INBOUND_EMAIL_SVIX_SECRET;  // Resend / Svix webhook signing secret

  // Diagnostic log — helps catch "I set the env var but it's not loading"
  // bugs that look identical to "no env var configured" at the response
  // level. Lengths only, never logs the secret value itself. Includes
  // every Svix-style header presence flag so we can see exactly what
  // naming the source is using (svix-* vs webhook-*).
  console.log('[inbound-email] auth check', {
    shared_secret_len: sharedSecret?.length || 0,
    svix_secret_len:   svixSecret?.length   || 0,
    raw_body_len:      req.rawBody?.length  || 0,
    headers_svix_id:        !!req.headers['svix-id'],
    headers_svix_timestamp: !!req.headers['svix-timestamp'],
    headers_svix_signature: !!req.headers['svix-signature'],
    headers_webhook_id:        !!req.headers['webhook-id'],
    headers_webhook_timestamp: !!req.headers['webhook-timestamp'],
    headers_webhook_signature: !!req.headers['webhook-signature'],
    headers_x_inbound_secret:  !!req.headers['x-inbound-secret'],
  });

  if (!sharedSecret && !svixSecret) {
    console.warn('[inbound-email] no INBOUND_EMAIL_SECRET or INBOUND_EMAIL_SVIX_SECRET set.');
    return res.status(503).json({ message: 'inbound email not configured' });
  }

  // 1. Shared-secret path: header presence + match.
  if (sharedSecret && req.headers['x-inbound-secret']) {
    if (req.headers['x-inbound-secret'] !== sharedSecret) {
      return res.status(401).json({ message: 'invalid inbound secret' });
    }
    return next();
  }

  // 2. Svix signature path (Resend Inbound). Required headers, with
  //    optional alternate naming (Resend supports both svix-* and
  //    webhook-* — different webhooks use different prefixes):
  //      svix-id        OR webhook-id
  //      svix-timestamp OR webhook-timestamp
  //      svix-signature OR webhook-signature
  //    Signature format: "v1,<base64-of-HMAC-SHA256-bytes> v1,<another>..."
  //    Signed payload:  `${id}.${timestamp}.${rawBody}`
  //    Key:             base64 of (svix-secret stripped of `whsec_` prefix)
  const sigHdr = req.headers['svix-signature'] || req.headers['webhook-signature'];
  if (svixSecret && sigHdr) {
    try {
      const svixId  = req.headers['svix-id']        || req.headers['webhook-id'];
      const svixTs  = req.headers['svix-timestamp'] || req.headers['webhook-timestamp'];
      const rawBody = req.rawBody; // populated by the raw-body middleware below
      if (!svixId || !svixTs || !sigHdr || !rawBody) {
        return res.status(400).json({ message: 'missing svix headers or raw body' });
      }
      // Reject stale signatures (>5 min) to prevent replay.
      const tsNum = parseInt(svixTs, 10);
      if (!Number.isFinite(tsNum) || Math.abs(Math.floor(Date.now() / 1000) - tsNum) > 300) {
        return res.status(401).json({ message: 'svix timestamp out of window' });
      }
      const keyB64 = svixSecret.replace(/^whsec_/, '');
      const key = Buffer.from(keyB64, 'base64');
      const signedPayload = `${svixId}.${svixTs}.${rawBody}`;
      const expected = crypto.createHmac('sha256', key).update(signedPayload).digest('base64');
      // Header lists multiple "v1,<sig>" separated by spaces — accept if any match.
      const provided = sigHdr.split(' ').map((p) => p.split(',')[1]).filter(Boolean);
      const ok = provided.some((p) => {
        try { return crypto.timingSafeEqual(Buffer.from(p), Buffer.from(expected)); }
        catch { return false; }
      });
      if (!ok) return res.status(401).json({ message: 'svix signature mismatch' });
      return next();
    } catch (e) {
      console.warn('[inbound-email] svix verify error:', e.message);
      return res.status(401).json({ message: 'svix verify failed' });
    }
  }

  return res.status(401).json({ message: 'no recognized auth header' });
}

// Resend Inbound + many other webhook sources wrap the email in a
// { type, data: {...} } envelope; the Cloudflare Worker we ship sends
// a flat shape. Normalize to one internal representation so the
// handler below stays simple.
function normalizeInboundBody(body) {
  if (!body || typeof body !== 'object') return {};
  // Resend / Svix-style: { type: 'email.received', data: {...} }
  if (body.data && typeof body.data === 'object' && body.type) {
    const d = body.data;
    // Resend's 'to' is an array; we only care about the first match.
    const to = Array.isArray(d.to) ? d.to[0] : (d.to || '');
    // Headers may come as an object map or an array of {name, value}.
    let messageId = d.message_id || null;
    if (!messageId && d.headers) {
      if (Array.isArray(d.headers)) {
        const h = d.headers.find((x) => /^message[-_]?id$/i.test(x?.name || ''));
        if (h) messageId = h.value;
      } else if (typeof d.headers === 'object') {
        messageId = d.headers['message-id'] || d.headers['Message-ID'] || null;
      }
    }
    return {
      to,
      from:       d.from?.email || d.from || '',
      subject:    d.subject || '',
      text:       d.text || '',
      html:       d.html || '',
      message_id: messageId,
    };
  }
  // Flat / Cloudflare Worker shape.
  return {
    to:         body.to || '',
    from:       body.from || '',
    subject:    body.subject || '',
    text:       body.text || '',
    html:       body.html || '',
    message_id: body.message_id || null,
  };
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
// Capture the raw request body before JSON parsing — needed to verify
// the Svix signature, which is computed over the exact bytes Resend
// sent.
const captureRaw = express.json({
  limit: '5mb',
  verify: (req, _res, buf) => { req.rawBody = buf.toString('utf8'); },
});

router.post('/projects/messages/inbound', captureRaw, verifyInboundAuth, async (req, res, next) => {
  try {
    const b = normalizeInboundBody(req.body);
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
