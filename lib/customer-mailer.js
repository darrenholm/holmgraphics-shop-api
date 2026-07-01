// lib/customer-mailer.js
// Transactional email for online customers -- activation, password reset,
// order confirmation, proof requests, shipping notifications, refunds.
//
// Provider: Resend (https://resend.com/).
// Picked over Postmark because we already use Resend for another project
// -- one dashboard, one bill, one domain verification to keep current.
//
// To use:
//   1. Resend dashboard -&gt; Domains -- if holmgraphics.ca isn't already
//      verified for the other project, add it here. (Same DNS records
//      can serve both projects -- Resend doesn't isolate per-account
//      DKIM unless you ask.)
//   2. Resend dashboard -&gt; API Keys -&gt; create a key scoped to "Sending
//      access" only. Copy the key.
//   3. In Railway: set RESEND_API_KEY to that value, and
//      SHOP_FROM_EMAIL to a verified sender (e.g.
//      'Holm Graphics <orders@holmgraphics.ca>').
//
// Without RESEND_API_KEY this module falls back to console-only
// logging -- same behaviour as the old stub. Lets dev environments boot
// without a Resend account.
//
// Failure policy: this module NEVER throws. Send failures return
// { ok: false, error } so callers stay robust whether they await or
// fire-and-forget. The four call sites (customer-auth, orders,
// orders-admin, proofs) can decide whether to surface that to the user.
//
// Public surface -- kept stable across the stub-&gt;real swap:
//
//   sendActivationEmail({ email, token, name })
//   sendPasswordResetEmail({ email, token, name })
//   sendOrderConfirmation({ email, order })
//   sendProofRequest({ email, order, proof, approvalUrl })
//   sendOrderApproved({ email, order })
//   sendOrderShipped({ email, order })
//   sendOrderReadyForPickup({ email, order })
//   sendOrderRefunded({ email, order, amount })

'use strict';

const PUBLIC_BASE = process.env.PUBLIC_SHOP_URL || 'https://holmgraphics.ca';
const SHOP_FROM   = process.env.SHOP_FROM_EMAIL || 'Holm Graphics <orders@holmgraphics.ca>';
const REPLY_TO    = process.env.SHOP_REPLY_TO   || ''; // optional
const PHONE       = '519-507-3001';
const PICKUP_ADDR = '2-43 Eastridge Rd, Walkerton ON N0G 2V0';

const RESEND_API_KEY = process.env.RESEND_API_KEY || '';
const RESEND_URL     = 'https://api.resend.com/emails';

// Status IDs that trigger transactional emails. These mirror the projects
// status lookup table and are duplicated in lib/promote-job.js — keep in
// sync if the lookup table is ever renumbered.
const STATUS_ID_ORDERED  = 2;   // "Ordered"     → order confirmation
const STATUS_ID_PROOFING = 5;   // "Proofing"    → proof ready for review
const STATUS_ID_READY    = 9;   // "Pickup/Del." → ready-for-pickup OR shipped

// --- Core send ----------------------------------------------------------------
// Wraps the Resend REST call. If no API key is configured, logs and
// returns ok:true with stub:true (so dev environments behave as before).
//
// `to` may be a single email, an array of emails, or a comma/semicolon-
// separated string (e.g. SHOP_QUOTES_TO="darren@…,brady@…"). Resend
// requires a true JS array — passing a comma string gets rejected with
// "Invalid `to` field … must be email@example.com or Name <email>".
function normalizeRecipients(to) {
  const arr = Array.isArray(to) ? to : [to];
  return arr
    .flatMap((entry) => String(entry || '').split(/[,;]+/))
    .map((s) => s.trim())
    .filter(Boolean);
}

// Resend only allows a `from` whose domain has been verified on the
// account. SHOP_FROM (e.g. `Holm Graphics <quotes@holmgraphics.ca>`) is
// the global default; per-call senders MUST live on the same domain or
// Resend will reject the request. This guard lets a caller pass a staff
// member as the visible From without us having to special-case every
// mail kind that wants personalised sending.
function fromOnVerifiedDomain(fromOverride) {
  if (!fromOverride) return null;
  const m = String(fromOverride).match(/<([^>]+)>|^([^<>\s]+@[^<>\s]+)$/);
  const addr = (m && (m[1] || m[2]) || '').toLowerCase();
  const dom  = addr.split('@')[1];
  if (!dom) return null;
  const shopDom = (SHOP_FROM.match(/@([^>\s]+)/) || [, ''])[1].toLowerCase();
  return shopDom && dom === shopDom ? fromOverride : null;
}

async function send({ to, bcc, subject, html, text, kind, replyTo, from, attachments }) {
  const recipients = normalizeRecipients(to);
  const bccList = bcc ? normalizeRecipients(bcc) : [];
  if (recipients.length === 0) {
    console.warn(`[mailer:${kind}] no recipients after normalize -- to:`, to);
    return { ok: false, error: 'no recipients' };
  }
  // Per-call from must be on the verified shop domain. Otherwise fall back
  // to SHOP_FROM so we never get a domain-mismatch rejection at Resend.
  const effectiveFrom = fromOnVerifiedDomain(from) || SHOP_FROM;
  if (!RESEND_API_KEY) {
    console.log(`[mailer:${kind}]`, JSON.stringify({ from: effectiveFrom, to: recipients, subject, attachments: (attachments || []).map((a) => a.filename) }));
    return { ok: true, stub: true };
  }
  // Per-call replyTo wins over the global SHOP_REPLY_TO env so individual
  // messages (e.g. project-message-customer) can route replies to a staff
  // inbox rather than the no-reply From.
  const effectiveReplyTo = replyTo || REPLY_TO || '';
  // Resend's `attachments` takes [{ filename, content: base64String }] —
  // we accept Buffers from callers and base64-encode here so the call
  // sites stay simple.
  const resendAttachments = (attachments || []).map((a) => ({
    filename: a.filename,
    content: Buffer.isBuffer(a.content) ? a.content.toString('base64') : a.content,
    ...(a.contentType ? { content_type: a.contentType } : {}),
  }));
  const body = {
    from:    effectiveFrom,
    to:      recipients,
    subject,
    html,
    text,
    ...(bccList.length ? { bcc: bccList } : {}),
    ...(effectiveReplyTo ? { reply_to: effectiveReplyTo } : {}),
    ...(resendAttachments.length ? { attachments: resendAttachments } : {}),
  };
  try {
    const res = await fetch(RESEND_URL, {
      method:  'POST',
      headers: {
        'Accept':        'application/json',
        'Content-Type':  'application/json',
        'Authorization': `Bearer ${RESEND_API_KEY}`,
      },
      body: JSON.stringify(body),
    });
    const json = await res.json().catch(() => null);
    // Resend returns { id } on success, { name, message, statusCode } on error.
    if (!res.ok || (json && json.message && !json.id)) {
      const msg = json?.message || `HTTP ${res.status}`;
      console.warn(`[mailer:${kind}] Resend rejected:`, msg, '-- to:', recipients);
      return { ok: false, error: msg };
    }
    return { ok: true, message_id: json?.id };
  } catch (err) {
    console.warn(`[mailer:${kind}] Resend request failed:`, err.message, '-- to:', recipients);
    return { ok: false, error: err.message };
  }
}

// --- Template helpers ---------------------------------------------------------
// Email HTML is fragile -- most clients strip <style>, no flexbox, table
// layout works most reliably. Keep templates inline-styled and minimal.
//
// `wrap()` builds the shared shell (header, footer, brand colours).
// `escape()` HTML-escapes any dynamic value before it goes in the template.

function escape(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

function money(n) {
  const v = Number(n);
  if (!Number.isFinite(v)) return '';
  return v.toLocaleString('en-CA', { style: 'currency', currency: 'CAD' });
}

function wrap({ heading, bodyHtml, ctaUrl, ctaLabel }) {
  const cta = ctaUrl
    ? `
      <tr><td style="padding:24px 0 8px;">
        <table role="presentation" cellspacing="0" cellpadding="0" border="0">
          <tr><td bgcolor="#dc2626" style="border-radius:6px;">
            <a href="${escape(ctaUrl)}" target="_blank"
               style="display:inline-block;padding:14px 28px;color:#fff;font-family:Arial,sans-serif;font-weight:600;font-size:15px;text-decoration:none;">${escape(ctaLabel)}</a>
          </td></tr>
        </table>
      </td></tr>`
    : '';
  return `<!doctype html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#f5f5f5;font-family:Arial,sans-serif;color:#1a1a1a;">
  <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="background:#f5f5f5;padding:32px 12px;">
    <tr><td align="center">
      <table role="presentation" width="600" cellspacing="0" cellpadding="0" border="0" style="background:#fff;border-radius:8px;overflow:hidden;max-width:600px;width:100%;">
        <tr><td bgcolor="#1a1a1a" style="padding:24px 32px;color:#fff;font-family:Impact,Arial,sans-serif;font-size:24px;letter-spacing:0.06em;">
          HOLM <span style="color:#dc2626;">GRAPHICS</span>
        </td></tr>
        <tr><td style="padding:32px;">
          <h1 style="margin:0 0 16px;font-family:Arial,sans-serif;font-size:22px;color:#1a1a1a;line-height:1.3;">${escape(heading)}</h1>
          ${bodyHtml}
          ${cta}
        </td></tr>
        <tr><td bgcolor="#f8f9fa" style="padding:20px 32px;border-top:1px solid #e2e8f0;font-size:13px;color:#4a5568;line-height:1.6;">
          Holm Graphics Inc. &middot; ${escape(PICKUP_ADDR)}<br>
          Questions? Call ${escape(PHONE)} or reply to this email.
        </td></tr>
      </table>
    </td></tr>
  </table>
</body></html>`;
}

// --- Public functions --------------------------------------------------------

/**
 * Build a same-origin return path, or '' if the input is missing/unsafe.
 * Used to round-trip an advertiser who started at /advertise/my-ads back to
 * that page after they finish activation. Validates the path looks like a
 * site-relative URL to avoid open-redirect abuse.
 */
function safeReturnPath(returnPath) {
  if (!returnPath || typeof returnPath !== 'string') return '';
  // Must start with a single '/' (rejects //evil.com and protocol-relative).
  if (!returnPath.startsWith('/') || returnPath.startsWith('//')) return '';
  if (returnPath.length > 200) return '';
  return returnPath;
}

async function sendActivationEmail({ email, token, name, returnPath }) {
  const safe = safeReturnPath(returnPath);
  const qs   = safe ? `?return=${encodeURIComponent(safe)}` : '';
  const url  = `${PUBLIC_BASE}/shop/activate/${token}${qs}`;
  const greet = name ? `Hi ${name},` : 'Hi,';
  return send({
    to:      email,
    subject: 'Activate your Holm Graphics account',
    kind:    'activation',
    text:
`${greet}

Welcome to Holm Graphics. Click the link below to activate your account
and set your password:

${url}

If you didn't sign up, you can ignore this email -- the link expires in 7 days.

-- Holm Graphics
${PHONE}`,
    html: wrap({
      heading:  'Activate your account',
      bodyHtml:
        `<p style="margin:0 0 12px;">${escape(greet)}</p>
         <p style="margin:0 0 12px;">Welcome to Holm Graphics. Click the button below to set your password and finish activating your account.</p>
         <p style="margin:0 0 12px;color:#718096;font-size:13px;">If you didn't sign up, ignore this email -- the link expires in 7 days.</p>`,
      ctaUrl:   url,
      ctaLabel: 'Activate Account',
    }),
  });
}

async function sendPasswordResetEmail({ email, token, name }) {
  const url = `${PUBLIC_BASE}/shop/reset-password/${token}`;
  const greet = name ? `Hi ${name},` : 'Hi,';
  return send({
    to:      email,
    subject: 'Reset your Holm Graphics password',
    kind:    'password-reset',
    text:
`${greet}

We got a request to reset your Holm Graphics password. Use this link
within the next hour:

${url}

If you didn't request this, you can ignore this email -- your password
won't change.

-- Holm Graphics
${PHONE}`,
    html: wrap({
      heading: 'Reset your password',
      bodyHtml:
        `<p style="margin:0 0 12px;">${escape(greet)}</p>
         <p style="margin:0 0 12px;">We got a request to reset your password. Click the button to set a new one -- the link expires in 1 hour.</p>
         <p style="margin:0 0 12px;color:#718096;font-size:13px;">Didn't request this? Ignore this email and your password stays the same.</p>`,
      ctaUrl:   url,
      ctaLabel: 'Reset Password',
    }),
  });
}

async function sendOrderConfirmation({ email, order }) {
  const url = `${PUBLIC_BASE}/shop/order/${order.order_number}`;
  const isInvoice = order.payment_method === 'invoice_pending';
  // Format due_date as a human-readable date. Postgres DATE comes back as
  // either an ISO string or a Date object depending on driver settings —
  // handle both. Falls back to empty string if unset (defensive: should
  // always be set when payment_method='invoice_pending', per the
  // 015_net_terms migration application logic).
  let dueDateText = '';
  if (isInvoice && order.due_date) {
    const d = order.due_date instanceof Date ? order.due_date : new Date(order.due_date);
    if (!Number.isNaN(d.getTime())) {
      dueDateText = d.toLocaleDateString('en-CA', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' });
    }
  }
  const paymentLineText = isInvoice
    ? `Payment: invoice forthcoming, due ${dueDateText || '(see invoice)'} (${money(order.grand_total)})`
    : `Total:   ${money(order.grand_total)}`;
  const paymentLineHtml = isInvoice
    ? `<p style="margin:0 0 12px;">Thanks for your order. We'll email an invoice for <strong>${escape(money(order.grand_total))}</strong> shortly${dueDateText ? ` — payment is due <strong>${escape(dueDateText)}</strong>` : ''}.</p>`
    : `<p style="margin:0 0 12px;">Thanks for your order -- your card has been charged for <strong>${escape(money(order.grand_total))}</strong>.</p>`;
  return send({
    to:      email,
    subject: `Order #${order.order_number} confirmed -- Holm Graphics`,
    kind:    'order-confirmation',
    text:
`Thanks for your order!

Order #: ${order.order_number}
${paymentLineText}

Next step: upload your artwork at
${url}/upload

You can also see the order details and current status here:
${url}

-- Holm Graphics
${PHONE}`,
    html: wrap({
      heading:  `Order #${escape(order.order_number)} confirmed`,
      bodyHtml:
        `${paymentLineHtml}
         <p style="margin:0 0 12px;"><strong>Next step:</strong> upload your artwork so we can get production started.</p>`,
      ctaUrl:   `${url}/upload`,
      ctaLabel: 'Upload Artwork',
    }),
  });
}

async function sendProofRequest({ email, order, proof, approvalUrl }) {
  return send({
    to:      email,
    subject: `Proof ready for review -- order #${order.order_number}`,
    kind:    'proof-request',
    text:
`Your proof is ready.

Order:  #${order.order_number}
Proof:  #${proof.proof_number}

Review and approve here:
${approvalUrl}

We'll start production as soon as you approve. If anything needs to
change, you can request changes from the same page.

-- Holm Graphics
${PHONE}`,
    html: wrap({
      heading:  `Proof ready -- order #${escape(order.order_number)}`,
      bodyHtml:
        `<p style="margin:0 0 12px;">Your proof for proof #${escape(proof.proof_number)} is ready to review.</p>
         <p style="margin:0 0 12px;">Approve to start production, or request changes -- both options are on the proof page.</p>`,
      ctaUrl:   approvalUrl,
      ctaLabel: 'Review Proof',
    }),
  });
}

async function sendOrderApproved({ email, order }) {
  const url = `${PUBLIC_BASE}/shop/order/${order.order_number}`;
  return send({
    to:      email,
    subject: `Order #${order.order_number} approved -- heading to production`,
    kind:    'order-approved',
    text:
`Thanks for approving the proof. Order #${order.order_number} is now
in production. We'll let you know when it ships (or is ready for
pickup).

Order details: ${url}

-- Holm Graphics
${PHONE}`,
    html: wrap({
      heading:  `Order #${escape(order.order_number)} in production`,
      bodyHtml:
        `<p style="margin:0 0 12px;">Thanks for approving the proof -- your order is now in production.</p>
         <p style="margin:0 0 12px;">We'll email again when it ships or is ready for pickup.</p>`,
      ctaUrl:   url,
      ctaLabel: 'View Order',
    }),
  });
}

async function sendOrderShipped({ email, order }) {
  const url = `${PUBLIC_BASE}/shop/order/${order.order_number}`;
  const carrier = order.shipping_carrier || 'Carrier';
  const tracking = order.tracking_number || '';
  return send({
    to:      email,
    subject: `Order #${order.order_number} shipped -- Holm Graphics`,
    kind:    'order-shipped',
    text:
`Your order is on its way.

Order:    #${order.order_number}
Carrier:  ${carrier}
${tracking ? `Tracking: ${tracking}\n` : ''}
Order details: ${url}

-- Holm Graphics
${PHONE}`,
    html: wrap({
      heading:  `Order #${escape(order.order_number)} shipped`,
      bodyHtml:
        `<p style="margin:0 0 12px;">Your order is on its way via <strong>${escape(carrier)}</strong>.</p>
         ${tracking ? `<p style="margin:0 0 12px;">Tracking number: <strong>${escape(tracking)}</strong></p>` : ''}`,
      ctaUrl:   url,
      ctaLabel: 'View Order',
    }),
  });
}

async function sendOrderReadyForPickup({ email, order }) {
  const url = `${PUBLIC_BASE}/shop/order/${order.order_number}`;
  return send({
    to:      email,
    subject: `Order #${order.order_number} ready for pickup`,
    kind:    'order-ready-for-pickup',
    text:
`Your order is ready for pickup.

Order:  #${order.order_number}
Pickup: ${PICKUP_ADDR}
        Mon-Fri 8am-4:30pm (call ahead if you need a different time)
Phone:  ${PHONE}

Order details: ${url}

-- Holm Graphics`,
    html: wrap({
      heading:  `Order #${escape(order.order_number)} ready for pickup`,
      bodyHtml:
        `<p style="margin:0 0 12px;">Your order is ready to pick up at:</p>
         <p style="margin:0 0 12px;"><strong>${escape(PICKUP_ADDR)}</strong><br>
            Mon-Fri 8am-4:30pm (call ahead for other times: ${escape(PHONE)})</p>`,
      ctaUrl:   url,
      ctaLabel: 'View Order',
    }),
  });
}

// Project-based "ready for pickup" — the job-card version, for projects that
// may have no online order behind them. Triggered by the staff "Notify ready
// for pickup" button (routes/projects.js → lib/client-notifier.js), not by an
// order status change. No order number / order link to show.
async function sendProjectReadyForPickup({ email, projectName, contactName }) {
  const who   = contactName ? `Hi ${contactName}, ` : '';
  const title = projectName ? `"${projectName}"` : 'Your order';
  return send({
    to:      email,
    subject: `${projectName ? projectName + ' — ' : ''}Ready for pickup`,
    kind:    'project-ready-for-pickup',
    text:
`${who}${title} is ready for pickup.

Pickup: ${PICKUP_ADDR}
        Mon-Fri 8am-4:30pm (call ahead if you need a different time)
Phone:  ${PHONE}

-- Holm Graphics`,
    html: wrap({
      heading: 'Ready for pickup',
      bodyHtml:
        `<p style="margin:0 0 12px;">${escape(who)}${escape(title)} is ready to pick up at:</p>
         <p style="margin:0 0 12px;"><strong>${escape(PICKUP_ADDR)}</strong><br>
            Mon-Fri 8am-4:30pm (call ahead for other times: ${escape(PHONE)})</p>`,
    }),
  });
}

// Staff notification of a new quote request from the marketing site
// quote form. `to` defaults to SHOP_QUOTES_TO env var; falls back to
// the inbox part of SHOP_FROM_EMAIL so we always have somewhere to send.
async function sendQuoteRequestNotification({ name, company, email, phone, service, details }) {
  const fromAddr = (SHOP_FROM.match(/<([^>]+)>/) || [, SHOP_FROM])[1];
  const to = process.env.SHOP_QUOTES_TO || fromAddr;
  const summary = [
    `Name:    ${name || '(not given)'}`,
    company ? `Company: ${company}` : null,
    `Email:   ${email}`,
    phone ? `Phone:   ${phone}` : null,
    `Service: ${service || '(not specified)'}`,
    '',
    'Details:',
    details || '(no details provided)',
  ].filter((l) => l !== null).join('\n');

  return send({
    to,
    subject: `New quote request from ${name || email}`,
    kind:    'quote-request-notify',
    text:    summary + `\n\n-- holmgraphics.ca quote form`,
    html: wrap({
      heading: 'New quote request',
      bodyHtml:
        `<table cellpadding="6" cellspacing="0" style="font-size:14px;color:#1a1a1a;border-collapse:collapse;">
           <tr><td style="color:#718096;width:90px;">Name</td><td><strong>${escape(name || '(not given)')}</strong></td></tr>
           ${company ? `<tr><td style="color:#718096;">Company</td><td>${escape(company)}</td></tr>` : ''}
           <tr><td style="color:#718096;">Email</td><td><a href="mailto:${escape(email)}">${escape(email)}</a></td></tr>
           ${phone ? `<tr><td style="color:#718096;">Phone</td><td><a href="tel:${escape(phone)}">${escape(phone)}</a></td></tr>` : ''}
           <tr><td style="color:#718096;">Service</td><td>${escape(service || '(not specified)')}</td></tr>
         </table>
         <h3 style="margin:20px 0 8px;font-size:15px;">Details</h3>
         <p style="margin:0 0 12px;white-space:pre-wrap;">${escape(details || '(no details provided)')}</p>
         <p style="margin:16px 0 0;font-size:12px;color:#a0aec0;">Sent from the holmgraphics.ca quote form.</p>`,
    }),
  });
}

// Auto-acknowledge the customer so they know we got their request.
async function sendQuoteRequestAck({ email, name }) {
  const greet = name ? `Hi ${name},` : 'Hi,';
  return send({
    to:      email,
    subject: 'We got your quote request -- Holm Graphics',
    kind:    'quote-request-ack',
    text:
`${greet}

Thanks for reaching out. Your quote request landed in our inbox and a
real person will get back to you the same business day (often within
the hour during business hours).

If your project is time-sensitive, give us a call at ${PHONE}.

-- Holm Graphics`,
    html: wrap({
      heading: 'We got your quote request',
      bodyHtml:
        `<p style="margin:0 0 12px;">${escape(greet)}</p>
         <p style="margin:0 0 12px;">Thanks for reaching out. Your request landed in our inbox and a real person will get back to you the same business day -- often within the hour during business hours.</p>
         <p style="margin:0 0 12px;">If your project is time-sensitive, call us directly at <strong>${escape(PHONE)}</strong>.</p>`,
    }),
  });
}

// Sent to a client when staff issues a public upload-link for a job.
// uploadUrl is the public /upload/<token> page; expiresAt is when the
// link goes inert. recipientName is optional — falls back to "Hi,".
async function sendArtworkUploadInvite({ email, recipientName, jobNumber, uploadUrl, expiresAt, note, assignedEmail, assignedName }) {
  const greet = recipientName ? `Hi ${recipientName},` : 'Hi,';
  const expiryText = expiresAt
    ? new Date(expiresAt).toLocaleDateString('en-CA', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' })
    : null;
  const noteText = (note || '').trim();
  // Convert linebreaks to <br> for HTML rendering. (No need for full
  // markdown — just preserve the staff member's manual line breaks.)
  const noteHtml = noteText ? escape(noteText).replace(/\r?\n/g, '<br>') : '';
  // If the job has an assigned staff member with a verified-domain
  // email, send "from" them and route replies back. send() drops the
  // override if the domain isn't verified, so a stray external email
  // won't trip Resend — we fall back to SHOP_FROM in that case.
  const personalFrom = assignedEmail
    ? `${(assignedName || '').trim() || 'Holm Graphics'} <${assignedEmail}>`
    : null;
  return send({
    to:      email,
    subject: `Upload your artwork for job #${jobNumber} -- Holm Graphics`,
    kind:    'artwork-upload-invite',
    from:    personalFrom,
    replyTo: assignedEmail || undefined,
    text:
`${recipientName ? `Hi ${recipientName},` : 'Hi,'}
${noteText ? `
${noteText}
` : ''}
Your job #${jobNumber} is ready for artwork. Drop your files here:

${uploadUrl}

${expiryText ? `The link expires on ${expiryText}.` : ''}

Common file types are fine -- PNG, JPG, PDF, AI, EPS, CDR, SVG, PSD,
TIF/TIFF. Max 50 MB per file. Drag-and-drop, or click to pick. We'll
get a proof back to you once the artwork is in.

-- Holm Graphics
${PHONE}`,
    html: wrap({
      heading:  `Upload your artwork for job #${escape(jobNumber)}`,
      bodyHtml:
        `<p style="margin:0 0 12px;">${escape(greet)}</p>
         ${noteHtml ? `<p style="margin:0 0 16px;">${noteHtml}</p>` : ''}
         <p style="margin:0 0 12px;">Your job #${escape(jobNumber)} is ready for artwork. Click the button below to drop your files in -- no account or login required.</p>
         ${expiryText ? `<p style="margin:0 0 12px;color:#718096;font-size:13px;">The link expires on ${escape(expiryText)}.</p>` : ''}
         <p style="margin:0 0 12px;color:#718096;font-size:13px;">PNG, JPG, PDF, AI, EPS, CDR, SVG, PSD, TIF/TIFF -- max 50 MB per file.</p>`,
      ctaUrl:   uploadUrl,
      ctaLabel: 'Upload Artwork',
    }),
  });
}

// Sent to a staff inbox after a client uploads via the public link.
// Body is intentionally short -- the trigger is "go check the job folder
// on L:\". Routes to SHOP_QUOTES_TO so the same inbox that handles new
// quote requests catches these too.
async function sendStaffUploadNotification({ jobNumber, clientName, recipientEmail, uploadCount, assignedEmail }) {
  const fromAddr = (SHOP_FROM.match(/<([^>]+)>/) || [, SHOP_FROM])[1];
  // Generic ops inbox always notified; when the project has an assigned
  // production employee, add them so the person managing the job gets
  // pinged directly. Dedup so a single recipient never gets two copies
  // (e.g. when SHOP_QUOTES_TO is the same employee already on the project).
  const baseTo   = process.env.SHOP_QUOTES_TO || fromAddr;
  const baseList = String(baseTo)
    .split(/[,;]/)
    .map((s) => s.trim())
    .filter(Boolean);
  if (assignedEmail && typeof assignedEmail === 'string') {
    const normalized = assignedEmail.trim();
    if (normalized && !baseList.some((e) => e.toLowerCase() === normalized.toLowerCase())) {
      baseList.push(normalized);
    }
  }
  const to = baseList;
  const summary  = [
    `Job:       #${jobNumber}`,
    `Client:    ${clientName || '(unknown)'}`,
    `Uploaded:  ${uploadCount} file${uploadCount === 1 ? '' : 's'}`,
    `From:      ${recipientEmail || '(unknown)'}`,
  ].join('\n');
  return send({
    to,
    subject: `Client uploaded artwork for job #${jobNumber}`,
    kind:    'staff-client-upload-notify',
    text:
`${clientName || 'A client'} just dropped ${uploadCount} file${uploadCount === 1 ? '' : 's'} into job #${jobNumber}.

${summary}

Check the job folder on L:\\ for the files.

-- Holm Graphics auto-notification`,
    html: wrap({
      heading: `Client artwork uploaded -- job #${escape(jobNumber)}`,
      bodyHtml:
        `<p style="margin:0 0 12px;"><strong>${escape(clientName || 'A client')}</strong> just dropped <strong>${uploadCount} file${uploadCount === 1 ? '' : 's'}</strong> into job #${escape(jobNumber)}.</p>
         <table cellpadding="6" cellspacing="0" style="font-size:14px;color:#1a1a1a;border-collapse:collapse;margin:8px 0;">
           <tr><td style="color:#718096;width:90px;">Job</td><td><strong>#${escape(jobNumber)}</strong></td></tr>
           <tr><td style="color:#718096;">Client</td><td>${escape(clientName || '(unknown)')}</td></tr>
           <tr><td style="color:#718096;">Uploaded</td><td>${uploadCount} file${uploadCount === 1 ? '' : 's'}</td></tr>
           <tr><td style="color:#718096;">From</td><td><a href="mailto:${escape(recipientEmail || '')}">${escape(recipientEmail || '(unknown)')}</a></td></tr>
         </table>
         <p style="margin:0 0 12px;">Check the job folder on L:\\ for the files.</p>`,
    }),
  });
}

/**
 * "New message on job #N" notification. Used for both directions:
 *   audience='staff'    — customer posted; notify assigned staff + ops inbox
 *   audience='customer' — staff posted; notify the customer
 *
 * For audience='staff' the recipientEmail is the assigned production
 * employee (may be null — in that case only the SHOP_QUOTES_TO inbox
 * gets it). For audience='customer' it's required.
 */
// Customer-facing "your proof is ready" email. Embeds an inline preview
// of the proof JPEG so the customer can see it in their inbox before
// clicking through to the annotation viewer.
async function sendProjectProofRequest({ recipientEmail, projectId, projectName, version, approvalUrl, imageUrl, senderName, note, assignedEmail, assignedName }) {
  const fromAddr = (SHOP_FROM.match(/<([^>]+)>/) || [, SHOP_FROM])[1];
  // SHOP_QUOTES_TO can be a comma/semicolon list (we BCC the whole shop on
  // quote requests). Resend's `reply_to` accepts only a single address, so
  // pick the first one as a fallback.
  const staffInbox = process.env.SHOP_QUOTES_TO || fromAddr;
  const fallbackReply = String(staffInbox).split(/[,;]+/).map((s) => s.trim()).filter(Boolean)[0] || fromAddr;
  // If the job has an assigned staff member with a verified-domain email,
  // send "from" them and route replies to them. send() drops the override
  // if the domain isn't verified, so a stray external email won't break
  // anything — we just fall back to SHOP_FROM and the shared inbox.
  const personalFrom = assignedEmail
    ? `${(assignedName || '').trim() || 'Holm Graphics'} <${assignedEmail}>`
    : null;
  const replyToOne = assignedEmail || fallbackReply;
  const heading = `Proof ready for review — job #${projectId}${projectName ? ` (${escape(projectName)})` : ''}`;
  return send({
    to: recipientEmail,
    subject: `Proof v${version} — please review${projectName ? ` (${projectName})` : ''}`,
    kind: 'project-proof-request',
    from: personalFrom,
    replyTo: replyToOne,
    text:
`${senderName || 'Holm Graphics'} sent you proof v${version} for job #${projectId}${projectName ? ` (${projectName})` : ''}.

${note ? `Note: ${note}\n\n` : ''}Review and respond here:
${approvalUrl}

You can mark up the proof directly in the browser and either approve or request changes.

-- Holm Graphics`,
    html: wrap({
      heading,
      bodyHtml:
        `<p style="margin:0 0 12px;color:#1a1a1a;">
           <strong>${escape(senderName || 'Holm Graphics')}</strong> sent you
           <strong>proof v${escape(version)}</strong> for review.
         </p>
         ${note ? `<p style="margin:0 0 12px;padding:10px 14px;background:#fffbe6;border-radius:4px;color:#1a1a1a;font-size:14px;">${escape(note)}</p>` : ''}
         <p style="margin:0 0 16px;text-align:center;">
           <img src="${escape(imageUrl)}" alt="Proof v${escape(version)}"
                style="max-width:100%;max-height:480px;border:1px solid #e2e8f0;border-radius:4px;" />
         </p>
         <p style="margin:0 0 12px;color:#4a5568;font-size:13px;">
           Tap below to open the full proof. You can mark it up with arrows,
           rectangles, and notes — then either approve or request changes.
         </p>`,
      ctaUrl: approvalUrl, ctaLabel: 'Review proof',
    }),
  });
}

// Staff notification when the customer approves or requests changes.
async function sendProjectProofResponseToStaff({ recipientEmail, projectId, projectName, version, kind, customerName, text, annotationsCount, jobUrl, pdfBuffer }) {
  const fromAddr = (SHOP_FROM.match(/<([^>]+)>/) || [, SHOP_FROM])[1];
  const staffInbox = process.env.SHOP_QUOTES_TO || fromAddr;
  // Proof responses go to the assigned staffer ONLY when one is set —
  // they're the human responsible for prepping v(n+1). CC'ing the whole
  // shop list creates noise and the assignee can forward if they want
  // help. If no assignee, fall back to the shop list so the response
  // still reaches a human.
  const to = recipientEmail
    ? [recipientEmail]
    : String(staffInbox).split(/[,;]/).map((s) => s.trim()).filter(Boolean);
  const isApprove = kind === 'approve';
  const verb = isApprove ? 'APPROVED' : 'requested changes on';
  const subject = `${isApprove ? '✅' : '✏️'} ${customerName} ${verb} proof v${version} — job #${projectId}`;
  // Attach the annotated PDF on a changes-requested email so the staffer
  // can see exactly what was marked up without clicking through. Skipped
  // on approval (the customer hit Approve as-is — there's nothing
  // visual to show that the email body doesn't already say).
  const pdfAttach = (kind === 'changes' && pdfBuffer)
    ? [{
        filename: `proof-v${version}-annotated-job-${projectId}.pdf`,
        content: pdfBuffer,
        contentType: 'application/pdf',
      }]
    : undefined;
  return send({
    to,
    subject,
    kind: `project-proof-${kind}`,
    attachments: pdfAttach,
    text:
`${customerName} ${verb} proof v${version} for job #${projectId}${projectName ? ` (${projectName})` : ''}.

${text ? `Customer note:\n"${text}"\n\n` : ''}${annotationsCount ? `Customer added ${annotationsCount} annotation${annotationsCount === 1 ? '' : 's'} on the proof — ${pdfAttach ? 'see the attached PDF.' : "view them in the job's Proofs tab."}\n\n` : ''}Open the job: ${jobUrl}

-- Holm Graphics`,
    html: wrap({
      heading: `${isApprove ? '✅ Proof approved' : '✏️ Changes requested'} — job #${projectId}`,
      bodyHtml:
        `<p style="margin:0 0 12px;color:#1a1a1a;">
           <strong>${escape(customerName)}</strong> ${escape(verb)}
           <strong>proof v${escape(version)}</strong>
           ${projectName ? `for <strong>${escape(projectName)}</strong>` : ''}.
         </p>
         ${text ? `<blockquote style="margin:0 0 12px;padding:10px 14px;background:#f7fafc;border-left:3px solid #c0392b;color:#1a1a1a;white-space:pre-wrap;">${escape(text)}</blockquote>` : ''}
         ${annotationsCount ? `<p style="margin:0 0 12px;color:#4a5568;font-size:13px;">Customer added <strong>${annotationsCount}</strong> annotation${annotationsCount === 1 ? '' : 's'} on the proof. ${pdfAttach ? 'See the attached PDF for the marked-up version.' : "Open the job's Proofs tab to view them."}</p>` : ''}`,
      ctaUrl: jobUrl, ctaLabel: 'Open job in board',
    }),
  });
}

async function sendProjectMessageNotification({ recipientEmail, audience, projectId, projectName, authorName, body, replyToEmail }) {
  const fromAddr = (SHOP_FROM.match(/<([^>]+)>/) || [, SHOP_FROM])[1];
  const staffInbox = process.env.SHOP_QUOTES_TO || fromAddr;

  // Build the recipient list. Customer audience: just their email.
  // Staff audience: assigned staff (if any) plus the ops inbox, deduped.
  const to = [];
  if (audience === 'customer') {
    if (!recipientEmail) return { ok: false, error: 'customer audience requires recipientEmail' };
    to.push(recipientEmail);
  } else {
    String(staffInbox).split(/[,;]/).map((s) => s.trim()).filter(Boolean).forEach((e) => to.push(e));
    if (recipientEmail && !to.some((e) => e.toLowerCase() === recipientEmail.toLowerCase())) {
      to.push(recipientEmail);
    }
  }

  const heading = audience === 'customer'
    ? `New message on your job #${projectId}`
    : `New customer message on job #${projectId}`;
  const truncated = body.length > 600 ? body.slice(0, 600) + '…' : body;

  // Customer replies route through the inbound-email subdomain (when
  // configured via INBOUND_EMAIL_DOMAIN) so they round-trip back into
  // the Messages tab. The address encodes the job id with `+job<id>`;
  // an optional local-part prefix carries the assigned staff's local
  // part so a reply lands at a human-named address in inbox previews
  // (e.g. `darren+job1234@reply.holmgraphics.ca`) rather than just a
  // bare `job1234@`.
  //
  // If INBOUND_EMAIL_DOMAIN is unset, we fall back to the previous
  // behaviour (reply lands directly in the assigned staff's inbox /
  // SHOP_QUOTES_TO with no auto-store).
  const inboundDomain = process.env.INBOUND_EMAIL_DOMAIN || '';
  let replyTo;
  if (audience === 'customer') {
    if (inboundDomain) {
      const localPrefix = (replyToEmail && replyToEmail.includes('@'))
        ? replyToEmail.split('@')[0]
        : 'staff';
      replyTo = `${localPrefix}+job${projectId}@${inboundDomain}`;
    } else {
      replyTo = replyToEmail || staffInbox;
    }
  } else {
    // Staff audience uses the same inbound trick so when staff hits
    // reply on the "customer replied" notification, their reply also
    // round-trips back through the Messages tab.
    if (inboundDomain) {
      const localPrefix = (replyToEmail && replyToEmail.includes('@'))
        ? replyToEmail.split('@')[0]
        : 'staff';
      replyTo = `${localPrefix}+job${projectId}@${inboundDomain}`;
    }
  }
  const replyHint = audience === 'customer'
    ? 'Reply to this email to respond — your reply will reach the team handling your job.'
    : null;

  return send({
    to,
    subject: heading,
    kind:    `project-message-${audience}`,
    replyTo,
    text:
`${authorName || 'A customer'} just posted on job #${projectId}${projectName ? ` (${projectName})` : ''}:

"${truncated}"
${audience === 'customer'
  ? `\nReply to this email to respond — your reply goes straight to the team handling your job.\n`
  : `\nReply in the job board: ${PUBLIC_BASE}/jobs/${projectId}\n`}
-- Holm Graphics`,
    html: wrap({
      heading,
      bodyHtml:
        `<p style="margin:0 0 12px;color:#1a1a1a;">
           <strong>${escape(authorName || 'A customer')}</strong> posted on
           <strong>job #${escape(projectId)}</strong>${projectName ? ` (${escape(projectName)})` : ''}:
         </p>
         <blockquote style="margin:0 0 16px;padding:12px 16px;background:#f7fafc;border-left:3px solid #c0392b;color:#1a1a1a;white-space:pre-wrap;">${escape(truncated)}</blockquote>
         ${replyHint ? `<p style="margin:16px 0 0;padding:12px 14px;background:#fffbe6;border-radius:4px;color:#1a1a1a;font-size:14px;">↪ ${escape(replyHint)}</p>` : ''}`,
      // Staff audience keeps the deep link into the job board. Customers
      // get no CTA button — the reply path is the email reply, which is
      // far less friction than activating a portal account.
      ctaUrl:   audience === 'customer' ? null : `${PUBLIC_BASE}/jobs/${projectId}`,
      ctaLabel: audience === 'customer' ? null : 'Open in job board',
    }),
  });
}

async function sendOrderRefunded({ email, order, amount }) {
  const url = `${PUBLIC_BASE}/shop/order/${order.order_number}`;
  return send({
    to:      email,
    subject: `Refund issued -- order #${order.order_number}`,
    kind:    'order-refunded',
    text:
`A refund of ${money(amount)} has been issued for order
#${order.order_number}. It usually shows up on your card within
3-5 business days, depending on your bank.

Order details: ${url}

If you have questions, reply to this email or call ${PHONE}.

-- Holm Graphics`,
    html: wrap({
      heading:  `Refund issued -- order #${escape(order.order_number)}`,
      bodyHtml:
        `<p style="margin:0 0 12px;">A refund of <strong>${escape(money(amount))}</strong> has been issued.</p>
         <p style="margin:0 0 12px;color:#4a5568;">It usually shows up on your card within 3-5 business days, depending on your bank.</p>`,
      ctaUrl:   url,
      ctaLabel: 'View Order',
    }),
  });
}

// Staff-sent job quote — emails the generated PDF straight to the customer
// (server-side via Resend) so staff no longer hand off to a desktop mail
// client. The quote appears to come FROM the sending staff member (dropped to
// SHOP_FROM if their address isn't on the verified domain), replies route back
// to them, and they're BCC'd so they keep a copy in their own inbox — replacing
// the old "leave a copy in Sent" behaviour without depending on the mail client.
async function sendJobQuote({ to, bccSelf, fromName, fromEmail, replyTo, subject, bodyText, pdfBase64, pdfFilename }) {
  const personalFrom = fromEmail
    ? `${String(fromName || 'Holm Graphics').replace(/[<>"]/g, '')} <${fromEmail}>`
    : null;
  return send({
    to,
    bcc:     bccSelf || undefined,
    from:    personalFrom,                       // send() falls back to SHOP_FROM if off-domain
    replyTo: replyTo || fromEmail || undefined,
    subject: subject || 'Your quote from Holm Graphics',
    kind:    'job-quote',
    text:    bodyText || 'Your quote is attached.',
    html: wrap({
      heading:  escape(subject || 'Your quote'),
      bodyHtml:
        `<p style="margin:0 0 12px;white-space:pre-wrap;">${escape(bodyText || '')}</p>
         <p style="margin:12px 0 0;color:#718096;font-size:13px;">Your detailed quote is attached as a PDF.</p>`,
    }),
    attachments: pdfBase64
      ? [{ filename: pdfFilename || 'quote.pdf', content: pdfBase64, contentType: 'application/pdf' }]
      : undefined,
  });
}

// ─── Status-driven dispatcher ────────────────────────────────────────────────
// Single entry point for "the project's status_id just became X — email the
// customer if there's an email tied to status X and we haven't sent it for
// this order yet." Idempotent via the email_log table:
//   * UNIQUE (order_id, kind) WHERE ok=TRUE — a successful send is recorded
//     once, and the next call with the same status sees the row and skips.
//   * Failures are recorded with ok=FALSE; an admin can DELETE the failure
//     row to re-trigger a retry. (No automatic retry — keep it explicit.)
//
// Always called AFTER the caller commits the status-update transaction so
// a Resend HTTP failure can never roll back DB state. The function never
// throws — callers can fire-and-forget or await; either way DB writes are
// already committed by then.
//
// Parameters:
//   orderId    — orders.id (NOT order_number)
//   statusId   — the new projects.status_id
//   db         — { query, queryOne } from db/connection (caller passes; we
//                avoid importing it here to dodge a circular dep on tests)
//
// Returns: { sent: bool, kind: string|null, reason: string|null }
// ─── Staff alert on a new online order ───────────────────────────────────────
// Fires once per order when checkout completes (status flips to ORDERED=2).
// Recipients come from env SHOP_NEW_ORDER_TO — comma/semicolon/space-separated
// addresses. If unset, falls back to the From: address (so dev environments
// at least get something visible).
//
// Idempotent via email_log (kind='staff-new-order-alert'): re-runs of the
// order-creation flow won't re-send. Each recipient is sent independently
// so a single bad address doesn't block the others.
async function sendStaffNewOrderAlert({ orderId, db }) {
  const fromAddr = (SHOP_FROM.match(/<([^>]+)>/) || [, SHOP_FROM])[1];
  const recipients = (process.env.SHOP_NEW_ORDER_TO || fromAddr)
    .split(/[,;\s]+/).map(r => r.trim()).filter(Boolean);
  if (recipients.length === 0) {
    return { sent: false, reason: 'no_recipients' };
  }

  // Idempotency — same email_log row used as the customer confirmation,
  // just under a different kind so they don't collide.
  const already = await db.queryOne(
    `SELECT id FROM email_log
      WHERE order_id = $1 AND kind = 'staff-new-order-alert' AND ok = TRUE
      LIMIT 1`,
    [orderId]
  );
  if (already) {
    return { sent: false, reason: 'already_sent' };
  }

  // Resolve order + customer + items + project for the body.
  let order, customer, items;
  try {
    order = await db.queryOne(
      `SELECT id, order_number, fulfillment_method, payment_method,
              grand_total, notification_email, client_id,
              created_at
         FROM orders WHERE id = $1`,
      [orderId]
    );
    if (!order) return { sent: false, reason: 'order_not_found' };
    customer = order.client_id
      ? await db.queryOne(
          `SELECT fname, lname, email, phone, company FROM clients WHERE id = $1`,
          [order.client_id]
        )
      : null;
    items = await db.query(
      `SELECT product_name, color_name, size, quantity, line_subtotal
         FROM order_items WHERE order_id = $1 ORDER BY id`,
      [orderId]
    );
  } catch (err) {
    console.warn(`[mailer:sendStaffNewOrderAlert] db lookup failed for order ${orderId}:`, err.message);
    return { sent: false, reason: 'db_error' };
  }

  const customerName = customer
    ? [customer.fname, customer.lname].filter(Boolean).join(' ').trim() || (customer.company || '')
    : '(no account)';
  const customerLine = customer
    ? `${customerName}${customer.email ? ' · ' + customer.email : ''}${customer.phone ? ' · ' + customer.phone : ''}`
    : '(walk-in / unknown)';

  const itemsText = items.length
    ? items.map(i => {
        const variant = [i.color_name, i.size].filter(Boolean).join(' / ');
        const label = i.product_name || 'Item';
        return `  ${i.quantity}× ${label}${variant ? ' (' + variant + ')' : ''} — ${money(i.line_subtotal)}`;
      }).join('\n')
    : '  (no items)';
  const itemsHtml = items.length
    ? '<ul style="margin:0 0 12px;padding-left:18px;">' +
      items.map(i => {
        const variant = [i.color_name, i.size].filter(Boolean).join(' / ');
        const label = i.product_name || 'Item';
        return `<li><strong>${escape(String(i.quantity))}×</strong> ${escape(label)}${variant ? ' <span style="color:#718096;">(' + escape(variant) + ')</span>' : ''} — ${escape(money(i.line_subtotal))}</li>`;
      }).join('') +
      '</ul>'
    : '<p style="margin:0 0 12px;color:#718096;">(no items)</p>';

  const adminUrl = `https://shop.holmgraphics.ca/orders/${order.id}`;
  const fulfillment = order.fulfillment_method === 'pickup' ? 'Pickup' : 'Shipping';
  const paymentLine = order.payment_method === 'invoice_pending'
    ? 'Invoice (payment forthcoming)'
    : 'Paid online';

  const subject = `New order #${order.order_number} — ${money(order.grand_total)} — ${customerName || 'walk-in'}`;
  const text =
`New online order received.

Order #:    ${order.order_number}
Total:      ${money(order.grand_total)}
Payment:    ${paymentLine}
Fulfilment: ${fulfillment}
Customer:   ${customerLine}

Items:
${itemsText}

Admin:      ${adminUrl}
`;
  const html = wrap({
    heading: `New order #${escape(order.order_number)}`,
    bodyHtml:
      `<table cellpadding="6" cellspacing="0" style="font-size:14px;color:#1a1a1a;border-collapse:collapse;margin-bottom:14px;">
         <tr><td style="color:#718096;width:90px;">Total</td><td><strong>${escape(money(order.grand_total))}</strong></td></tr>
         <tr><td style="color:#718096;">Payment</td><td>${escape(paymentLine)}</td></tr>
         <tr><td style="color:#718096;">Fulfilment</td><td>${escape(fulfillment)}</td></tr>
         <tr><td style="color:#718096;">Customer</td><td>${escape(customerName || '(walk-in)')}${customer && customer.email ? ` &middot; <a href="mailto:${escape(customer.email)}">${escape(customer.email)}</a>` : ''}${customer && customer.phone ? ` &middot; <a href="tel:${escape(customer.phone)}">${escape(customer.phone)}</a>` : ''}</td></tr>
       </table>
       <h3 style="margin:0 0 6px;font-size:14px;color:#1a1a1a;">Items</h3>
       ${itemsHtml}`,
    ctaUrl:   adminUrl,
    ctaLabel: 'Open in admin',
  });

  // Send to each recipient independently — collect results.
  const results = await Promise.all(
    recipients.map(to => send({ to, subject, html, text, kind: 'staff-new-order-alert' }))
  );
  const anyOk = results.some(r => r && r.ok);
  const firstErr = results.find(r => !r || !r.ok);

  // Log a single email_log row regardless — kind is the same; idempotency
  // is per-order, not per-recipient.
  try {
    await db.query(
      `INSERT INTO email_log (order_id, kind, ok, message_id, error)
            VALUES ($1, 'staff-new-order-alert', $2, $3, $4)
       ON CONFLICT (order_id, kind) WHERE ok = TRUE DO NOTHING`,
      [
        orderId,
        anyOk,
        results.find(r => r?.message_id)?.message_id || null,
        anyOk ? null : (firstErr?.error || 'all_recipients_failed'),
      ]
    );
  } catch (logErr) {
    if (logErr.code !== '23505') {
      console.warn(`[mailer:sendStaffNewOrderAlert] email_log INSERT failed for order ${orderId}:`, logErr.message);
    }
  }

  return anyOk
    ? { sent: true, recipients: recipients.length }
    : { sent: false, reason: 'send_failed', error: firstErr?.error || 'unknown' };
}

/**
 * Resolve the recipient email for project-related notifications (proof
 * request, ready-for-pickup, shipped, status change). Most-specific wins:
 *
 *   1. project.contact_email   — set by staff when the project contact
 *                                differs from the client's billing contact
 *   2. order.notification_email — per-order override captured at checkout
 *   3. client.email             — the account's primary/billing email
 *
 * Returns the first non-blank email, or null if none are set. Used by
 * sendForOrderStatus; exported via _internals so the precedence is
 * locked by a unit test rather than only by behavioural inspection.
 */
function pickRecipientEmail({ projectContactEmail, orderNotificationEmail, clientEmail }) {
  const project = (projectContactEmail || '').trim();
  if (project) return project;
  const order = (orderNotificationEmail || '').trim();
  if (order) return order;
  const client = (clientEmail || '').trim();
  return client || null;
}

async function sendForOrderStatus({ orderId, statusId, db }) {
  const kind = kindForStatus(statusId);
  if (!kind) return { sent: false, kind: null, reason: 'no_email_for_status' };

  // Resolve order + customer + linked project (for the project-contact override) +
  // (if proofing) latest proof.
  //
  // Recipient precedence for project-related emails (proof, status, ready,
  // shipped) — most specific wins:
  //   1. projects.contact_email   — set by staff on the project edit form when
  //                                 the project contact differs from the client's
  //                                 billing contact (e.g. a sales manager at the
  //                                 client whose AP department lives in clients.email).
  //   2. orders.notification_email — per-order override captured at checkout for
  //                                 customer-driven online orders without a project.
  //   3. clients.email             — the account's primary/billing email.
  //
  // QBO sales receipts / invoices still use clients.email regardless, so AP
  // continues to see the financial doc.
  let order, customer, project, recipientEmail;
  try {
    order = await db.queryOne(
      `SELECT o.id, o.order_number, o.fulfillment_method, o.grand_total,
              o.shipping_carrier, o.tracking_number, o.client_id,
              o.notification_email, o.payment_method, o.due_date,
              o.job_id
         FROM orders o
        WHERE o.id = $1`,
      [orderId]
    );
    if (!order) {
      return { sent: false, kind, reason: 'order_not_found' };
    }
    customer = await db.queryOne(
      `SELECT id, email, fname, lname FROM clients WHERE id = $1`,
      [order.client_id]
    );
    if (order.job_id) {
      project = await db.queryOne(
        `SELECT id, contact_email FROM projects WHERE id = $1`,
        [order.job_id]
      );
    }
  } catch (err) {
    console.warn(`[mailer:sendForOrderStatus] db lookup failed for order ${orderId}:`, err.message);
    return { sent: false, kind, reason: 'db_error' };
  }
  recipientEmail = pickRecipientEmail({
    projectContactEmail:   project && project.contact_email,
    orderNotificationEmail: order.notification_email,
    clientEmail:           customer && customer.email,
  });
  if (!recipientEmail) {
    return { sent: false, kind, reason: 'no_customer_email' };
  }

  // For pickup/delivery (status 9) the user-facing kind splits on
  // fulfillment_method. Compute the actual kind we'll log.
  const actualKind = kind === 'ready'
    ? (order.fulfillment_method === 'pickup' ? 'order-ready-for-pickup' : 'order-shipped')
    : kind;

  // Idempotency check.
  const already = await db.queryOne(
    `SELECT id FROM email_log
      WHERE order_id = $1 AND kind = $2 AND ok = TRUE
      LIMIT 1`,
    [orderId, actualKind]
  );
  if (already) {
    return { sent: false, kind: actualKind, reason: 'already_sent' };
  }

  // Dispatch to the appropriate template.
  let result;
  try {
    if (actualKind === 'order-confirmation') {
      result = await sendOrderConfirmation({ email: recipientEmail, order });
    } else if (actualKind === 'proof-request') {
      const proof = await db.queryOne(
        `SELECT proof_number, approval_token
           FROM proofs
          WHERE order_id = $1 AND cancelled_at IS NULL
          ORDER BY proof_number DESC
          LIMIT 1`,
        [orderId]
      );
      if (!proof) {
        // Status flipped to Proofing but no proof row exists yet. The proof
        // creation flow itself sends the proof email — this status hook is
        // a backstop for manual status edits, so silently skip.
        return { sent: false, kind: actualKind, reason: 'no_proof_yet' };
      }
      // TODO: build a real approvalUrl once the customer-facing approval
      // route is finalized. For now point at the order page; the customer
      // sees the proof there via /shop/order/<n>/proof/<token>.
      const approvalUrl = `${PUBLIC_BASE}/shop/order/${order.order_number}/proof/${proof.approval_token}`;
      result = await sendProofRequest({ email: recipientEmail, order, proof, approvalUrl });
    } else if (actualKind === 'order-ready-for-pickup') {
      result = await sendOrderReadyForPickup({ email: recipientEmail, order });
    } else if (actualKind === 'order-shipped') {
      result = await sendOrderShipped({ email: recipientEmail, order });
    } else {
      return { sent: false, kind: actualKind, reason: 'unknown_kind' };
    }
  } catch (err) {
    // Defensive — the underlying templates already swallow Resend errors,
    // but a bug in template construction (bad arg shape) could throw here.
    result = { ok: false, error: err.message };
  }

  // Record the outcome. The UNIQUE partial index on (order_id, kind) WHERE
  // ok=TRUE means a parallel successful send loses to the first writer.
  // ON CONFLICT must repeat the index's predicate so PG knows which
  // partial index to match. For ok=FALSE rows, no unique constraint
  // applies, so the row is always inserted (multiple failure attempts
  // accumulate, helpful for diagnostics).
  try {
    await db.query(
      `INSERT INTO email_log (order_id, kind, ok, message_id, error)
            VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (order_id, kind) WHERE ok = TRUE DO NOTHING`,
      [orderId, actualKind, !!result.ok, result.message_id || null, result.error || null]
    );
  } catch (logErr) {
    // 23505 = unique_violation — racing successful send. Customer already
    // got the email from the first writer; treat as success.
    if (logErr.code !== '23505') {
      console.warn(`[mailer:sendForOrderStatus] email_log INSERT failed for order ${orderId}:`, logErr.message);
    }
  }

  return result.ok
    ? { sent: true, kind: actualKind, message_id: result.message_id }
    : { sent: false, kind: actualKind, reason: 'send_failed', error: result.error };
}

function kindForStatus(statusId) {
  if (statusId === STATUS_ID_ORDERED)  return 'order-confirmation';
  if (statusId === STATUS_ID_PROOFING) return 'proof-request';
  if (statusId === STATUS_ID_READY)    return 'ready';   // splits on fulfillment_method
  return null;
}

// --- Decoration builder: admin notification on submit-for-proof -------------
// Fires when a buyer clicks "Submit for proof" in /shop/builder. There is no
// orders.id yet at this point — the draft is its own resource in
// `builder_drafts`. For v1, the admin manually creates the job/order from
// this email. Once promote-from-draft automation lands, this email will be
// supplemented (or replaced) by a job-board notification.
//
// Returns the same { ok, message_id?, stub?, error? } shape as the rest of
// the mailer. The caller (routes/builder-orders.js) uses message_id to
// stamp builder_drafts.notify_email_id for traceability.
async function sendBuilderSubmittedForProof({ to, draftId, state }) {
  const s = state || {};
  const contact = s._contact || {};
  const lineItems = Array.isArray(s.line_items) ? s.line_items : [];

  const totalPcs = lineItems.reduce((acc, li) => {
    const grid = Array.isArray(li.size_grid) ? li.size_grid : [];
    return acc + grid.reduce((a, g) => a + (Number(g.quantity) || 0), 0);
  }, 0);

  // Plain-text summary lines per garment (rendered the same way in HTML).
  const lines = lineItems.map((li) => {
    const grid = Array.isArray(li.size_grid) ? li.size_grid : [];
    const sizes = grid.map((g) => `${g.size}×${g.quantity}`).join(', ') || '(no sizes)';
    const locs = Array.isArray(li.locations) ? li.locations : [];
    const locText = locs.length
      ? locs.map((l) => {
          const tag = l.artwork_deferred
            ? ' [artwork TBD]'
            : (l.artwork_file_name ? ` [art: ${l.artwork_file_name}]` : ' [no art]');
          const name = l.design_name ? ` "${l.design_name}"` : '';
          return `      • ${l.view}/${l.label_wearer}${name}${tag}`;
        }).join('\n')
      : '      (no decoration locations)';
    return `  ${li.label || li.family || 'Garment'}\n    Sizes: ${sizes}\n${locText}`;
  }).join('\n\n') || '  (no garments)';

  const decorationMode = s.decoration_mode === 'per_garment' ? 'Per garment' : 'Uniform';
  const subject = `Builder submit · ${totalPcs} pcs · ${escape(contact.name || contact.email || 'unknown')}`;

  const text =
`A buyer submitted a decoration builder order for proof review.

Draft id:        ${draftId}
Contact:         ${contact.name || '(no name)'} <${contact.email || '(no email)'}>${contact.phone ? '  ' + contact.phone : ''}
Decoration mode: ${decorationMode}
Total pieces:    ${totalPcs}

Garments:

${lines}

Open the draft to review the buyer's selections, generate a proof mockup,
and reply to ${contact.email || 'the buyer'} with the proof and payment link.

(Once the proof-viewer flow ships, the buyer's approval URL will be
auto-generated here.)

-- Holm Graphics Shop
${PHONE}`;

  // HTML mirror — bullet list per garment, contact + totals at top.
  const itemsHtml = lineItems.length
    ? lineItems.map((li) => {
        const grid = Array.isArray(li.size_grid) ? li.size_grid : [];
        const sizes = grid.map((g) => `${escape(g.size)} × ${escape(String(g.quantity))}`).join(', ')
                   || '<span style="color:#718096;">(no sizes)</span>';
        const locs = Array.isArray(li.locations) ? li.locations : [];
        const locHtml = locs.length
          ? '<ul style="margin:4px 0 0;padding-left:18px;">' + locs.map((l) => {
              const tag = l.artwork_deferred
                ? ' <span style="color:#a16207;">[artwork to follow]</span>'
                : (l.artwork_file_name
                    ? ` <span style="color:#15803d;">[art: ${escape(l.artwork_file_name)}]</span>`
                    : ' <span style="color:#b91c1c;">[no art]</span>');
              const name = l.design_name ? ` &mdash; "${escape(l.design_name)}"` : '';
              return `<li>${escape(l.view)} / <strong>${escape(l.label_wearer)}</strong>${name}${tag}</li>`;
            }).join('') + '</ul>'
          : '<p style="margin:4px 0 0;color:#718096;">(no decoration locations)</p>';
        return `<li style="margin:0 0 14px;">
          <strong>${escape(li.label || li.family || 'Garment')}</strong><br>
          <span style="color:#4a5568;">Sizes: ${sizes}</span>
          ${locHtml}
        </li>`;
      }).join('')
    : '<li style="color:#718096;">(no garments)</li>';

  const bodyHtml =
    `<p style="margin:0 0 12px;">A buyer submitted a decoration builder order for proof review.</p>
     <table role="presentation" cellspacing="0" cellpadding="0" border="0" style="margin:0 0 16px;font-size:14px;">
       <tr><td style="color:#4a5568;padding:2px 12px 2px 0;">Draft id</td><td style="font-family:monospace;">${escape(draftId)}</td></tr>
       <tr><td style="color:#4a5568;padding:2px 12px 2px 0;">Contact</td><td>${escape(contact.name || '(no name)')} &lt;${escape(contact.email || '(no email)')}&gt;${contact.phone ? ' &middot; ' + escape(contact.phone) : ''}</td></tr>
       <tr><td style="color:#4a5568;padding:2px 12px 2px 0;">Decoration mode</td><td>${escape(decorationMode)}</td></tr>
       <tr><td style="color:#4a5568;padding:2px 12px 2px 0;">Total pieces</td><td><strong>${escape(String(totalPcs))}</strong></td></tr>
     </table>
     <h2 style="font-size:15px;margin:18px 0 8px;">Garments &amp; decoration</h2>
     <ul style="margin:0 0 16px;padding-left:18px;">${itemsHtml}</ul>
     <p style="margin:0;color:#4a5568;font-size:13px;">
       Generate a proof mockup and reply to the buyer with the proof and a payment link.
     </p>`;

  return send({
    to,
    subject,
    kind: 'builder-submitted-for-proof',
    text,
    html: wrap({ heading: 'New builder submission · ready for proof', bodyHtml })
  });
}

// --- Decoration builder: buyer-facing proof-ready email --------------------
// Fires when admin attaches a proof + payment link to a submitted draft
// (POST /api/builder/drafts/:id/send-proof). Buyer clicks the viewer URL to
// review the mockup and either approve or pay.
//
// `proofUrl` is the raw proof image URL (so the email can show a preview
// inline). `viewerUrl` is the /shop/builder/proof/{token} page where the
// buyer approves. `paymentUrl` is the admin's QBO invoice / checkout link.
async function sendBuilderProofReady({ to, name, viewerUrl, paymentUrl, proofUrl, message, state }) {
  const greet = name ? `Hi ${name},` : 'Hi,';
  const totalPcs = (() => {
    const items = Array.isArray(state?.line_items) ? state.line_items : [];
    return items.reduce((acc, li) => {
      const grid = Array.isArray(li.size_grid) ? li.size_grid : [];
      return acc + grid.reduce((a, g) => a + (Number(g.quantity) || 0), 0);
    }, 0);
  })();

  const adminNoteText = message
    ? `\n\nNote from us:\n${message}\n`
    : '';
  const adminNoteHtml = message
    ? `<div style="background:#fffbeb;border:1px solid #fde68a;padding:12px 14px;border-radius:6px;margin:0 0 16px;font-size:14px;color:#713f12;"><strong>Note:</strong> ${escape(message)}</div>`
    : '';

  return send({
    to,
    subject: `Your Holm Graphics proof is ready — review and approve`,
    kind:    'builder-proof-ready',
    text:
`${greet}

Your decoration proof is ready. Review the mockup, approve to send
it to print, and pay with the link below when you're ready.

Review and approve:  ${viewerUrl}
Pay:                 ${paymentUrl}
${adminNoteText}
Order summary: ${totalPcs} piece${totalPcs === 1 ? '' : 's'}

If anything looks off, reply to this email and we'll send a revised
proof — no need to approve until you're happy.

-- Holm Graphics
${PHONE}`,
    html: wrap({
      heading: 'Your proof is ready',
      bodyHtml:
        `<p style="margin:0 0 12px;">${escape(greet)}</p>
         <p style="margin:0 0 16px;">Your decoration proof is ready. Review the mockup below, then click <strong>Approve &amp; Pay</strong> to confirm and send it to print.</p>
         ${adminNoteHtml}
         ${proofUrl ? `<p style="margin:0 0 16px;text-align:center;"><img src="${escape(proofUrl)}" alt="Proof preview" style="max-width:100%;height:auto;border:1px solid #e2e8f0;border-radius:6px;" /></p>` : ''}
         <p style="margin:0 0 12px;color:#4a5568;font-size:13px;">Order: ${escape(String(totalPcs))} piece${totalPcs === 1 ? '' : 's'}</p>
         <p style="margin:0 0 12px;color:#4a5568;font-size:13px;">If anything looks off, just reply &mdash; we'll send a revised proof. No need to approve until you're happy.</p>`,
      ctaUrl:   viewerUrl,
      ctaLabel: 'Review &amp; Approve'
    })
  });
}

// --- Decoration builder: admin notice on buyer approval --------------------
// Fires from POST /api/builder/proof/:token/approve once the buyer clicks
// Approve in the viewer. Lets the staff know they can promote the draft into
// a real job/order and watch for payment via the QBO link.
async function sendBuilderApprovedNotice({ to, buyerEmail, buyerName, draftId, paymentUrl, state }) {
  const items = Array.isArray(state?.line_items) ? state.line_items : [];
  const totalPcs = items.reduce((acc, li) => {
    const grid = Array.isArray(li.size_grid) ? li.size_grid : [];
    return acc + grid.reduce((a, g) => a + (Number(g.quantity) || 0), 0);
  }, 0);

  const subject = `Builder approved · ${totalPcs} pcs · ${escape(buyerName || buyerEmail || 'buyer')}`;
  return send({
    to,
    subject,
    kind: 'builder-approved',
    text:
`Buyer approved their proof.

Buyer:      ${buyerName || '(no name)'} <${buyerEmail || '(no email)'}>
Draft id:   ${draftId}
Total pcs:  ${totalPcs}
Payment:    ${paymentUrl || '(no link on record)'}

Promote the draft into a job/order when ready, and watch the payment link
for the buyer's QBO transaction.

-- Holm Graphics Shop`,
    html: wrap({
      heading: 'Proof approved — ready to promote',
      bodyHtml:
        `<p style="margin:0 0 12px;">Buyer approved their proof. Promote the draft into a real job/order when you're ready.</p>
         <table role="presentation" cellspacing="0" cellpadding="0" border="0" style="margin:0 0 12px;font-size:14px;">
           <tr><td style="color:#4a5568;padding:2px 12px 2px 0;">Buyer</td><td>${escape(buyerName || '(no name)')} &lt;${escape(buyerEmail || '(no email)')}&gt;</td></tr>
           <tr><td style="color:#4a5568;padding:2px 12px 2px 0;">Draft id</td><td style="font-family:monospace;">${escape(draftId)}</td></tr>
           <tr><td style="color:#4a5568;padding:2px 12px 2px 0;">Total pieces</td><td><strong>${escape(String(totalPcs))}</strong></td></tr>
           ${paymentUrl ? `<tr><td style="color:#4a5568;padding:2px 12px 2px 0;">Payment link</td><td><a href="${escape(paymentUrl)}">${escape(paymentUrl)}</a></td></tr>` : ''}
         </table>`
    })
  });
}

module.exports = {
  sendJobQuote,
  sendActivationEmail,
  sendPasswordResetEmail,
  sendOrderConfirmation,
  sendProofRequest,
  sendOrderApproved,
  sendOrderShipped,
  sendOrderReadyForPickup,
  sendProjectReadyForPickup,
  sendOrderRefunded,
  sendQuoteRequestNotification,
  sendStaffNewOrderAlert,
  sendQuoteRequestAck,
  sendForOrderStatus,
  sendArtworkUploadInvite,
  sendStaffUploadNotification,
  sendBuilderSubmittedForProof,
  sendBuilderProofReady,
  sendBuilderApprovedNotice,
  sendProjectMessageNotification,
  sendProjectProofRequest,
  sendProjectProofResponseToStaff,
  // Future: SMS via Twilio for status_id 9 if customer opted in.
  // TODO(sms): wire orders.ship_to_phone / clients.phone into a
  // sendSmsForOrderStatus helper that mirrors sendForOrderStatus's
  // idempotency contract (separate sms_log table or kind suffix).
  // Pure helpers exposed for unit tests only.
  _internals: { pickRecipientEmail },
};
