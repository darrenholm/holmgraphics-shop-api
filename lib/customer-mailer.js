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
async function send({ to, subject, html, text, kind }) {
  if (!RESEND_API_KEY) {
    console.log(`[mailer:${kind}]`, JSON.stringify({ from: SHOP_FROM, to, subject }));
    return { ok: true, stub: true };
  }
  const body = {
    from:    SHOP_FROM,
    to:      [to],
    subject,
    html,
    text,
    ...(REPLY_TO ? { reply_to: REPLY_TO } : {}),
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
      console.warn(`[mailer:${kind}] Resend rejected:`, msg, '-- to:', to);
      return { ok: false, error: msg };
    }
    return { ok: true, message_id: json?.id };
  } catch (err) {
    console.warn(`[mailer:${kind}] Resend request failed:`, err.message, '-- to:', to);
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

async function sendActivationEmail({ email, token, name }) {
  const url = `${PUBLIC_BASE}/shop/activate/${token}`;
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
  return send({
    to:      email,
    subject: `Order #${order.order_number} confirmed -- Holm Graphics`,
    kind:    'order-confirmation',
    text:
`Thanks for your order!

Order #: ${order.order_number}
Total:   ${money(order.grand_total)}

Next step: upload your artwork at
${url}/upload

You can also see the order details and current status here:
${url}

-- Holm Graphics
${PHONE}`,
    html: wrap({
      heading:  `Order #${escape(order.order_number)} confirmed`,
      bodyHtml:
        `<p style="margin:0 0 12px;">Thanks for your order -- your card has been charged for <strong>${escape(money(order.grand_total))}</strong>.</p>
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
        Mon-Fri 9-5 (call ahead if you need a different time)
Phone:  ${PHONE}

Order details: ${url}

-- Holm Graphics`,
    html: wrap({
      heading:  `Order #${escape(order.order_number)} ready for pickup`,
      bodyHtml:
        `<p style="margin:0 0 12px;">Your order is ready to pick up at:</p>
         <p style="margin:0 0 12px;"><strong>${escape(PICKUP_ADDR)}</strong><br>
            Mon-Fri 9-5 (call ahead for other times: ${escape(PHONE)})</p>`,
      ctaUrl:   url,
      ctaLabel: 'View Order',
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
async function sendArtworkUploadInvite({ email, recipientName, jobNumber, uploadUrl, expiresAt }) {
  const greet = recipientName ? `Hi ${recipientName},` : 'Hi,';
  const expiryText = expiresAt
    ? new Date(expiresAt).toLocaleDateString('en-CA', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' })
    : null;
  return send({
    to:      email,
    subject: `Upload your artwork for job #${jobNumber} -- Holm Graphics`,
    kind:    'artwork-upload-invite',
    text:
`${recipientName ? `Hi ${recipientName},` : 'Hi,'}

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
async function sendStaffUploadNotification({ jobNumber, clientName, recipientEmail, uploadCount }) {
  const fromAddr = (SHOP_FROM.match(/<([^>]+)>/) || [, SHOP_FROM])[1];
  const to       = process.env.SHOP_QUOTES_TO || fromAddr;
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
async function sendForOrderStatus({ orderId, statusId, db }) {
  const kind = kindForStatus(statusId);
  if (!kind) return { sent: false, kind: null, reason: 'no_email_for_status' };

  // Resolve order + customer + (if proofing) latest proof. notification_email
  // is the per-order override captured at checkout — preferred over the
  // account's clients.email so customers can route a one-off order to a
  // different inbox without changing their login.
  let order, customer, recipientEmail;
  try {
    order = await db.queryOne(
      `SELECT o.id, o.order_number, o.fulfillment_method, o.grand_total,
              o.shipping_carrier, o.tracking_number, o.client_id,
              o.notification_email
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
  } catch (err) {
    console.warn(`[mailer:sendForOrderStatus] db lookup failed for order ${orderId}:`, err.message);
    return { sent: false, kind, reason: 'db_error' };
  }
  recipientEmail = (order.notification_email && order.notification_email.trim())
    || (customer && customer.email);
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

module.exports = {
  sendActivationEmail,
  sendPasswordResetEmail,
  sendOrderConfirmation,
  sendProofRequest,
  sendOrderApproved,
  sendOrderShipped,
  sendOrderReadyForPickup,
  sendOrderRefunded,
  sendQuoteRequestNotification,
  sendQuoteRequestAck,
  sendForOrderStatus,
  sendArtworkUploadInvite,
  sendStaffUploadNotification,
  // Future: SMS via Twilio for status_id 9 if customer opted in.
  // TODO(sms): wire orders.ship_to_phone / clients.phone into a
  // sendSmsForOrderStatus helper that mirrors sendForOrderStatus's
  // idempotency contract (separate sms_log table or kind suffix).
};
