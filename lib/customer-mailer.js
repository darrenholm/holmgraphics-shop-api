// lib/customer-mailer.js
// Transactional email for online customers — activation, password reset,
// order confirmation, proof requests, shipping notifications, refunds.
//
// CURRENT STATE: STUB. Logs to console only; nothing actually mailed.
// This unblocks development of the auth + order routes without forcing
// us to choose an email provider on day one.
//
// To go live, swap the body of each `send*` function for a real provider
// call (Postmark, SendGrid, Mailgun, AWS SES, etc.). Provider choice is
// deferred per docs/dtf-online-store-plan.md "Open items" #9.
//
// Public surface — keep these signatures stable so callers don't have to
// change when the real provider lands:
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

const PUBLIC_BASE = process.env.PUBLIC_SHOP_URL || 'https://shop.holmgraphics.ca';
const SHOP_FROM   = process.env.SHOP_FROM_EMAIL || 'Holm Graphics <orders@holmgraphics.ca>';

function log(kind, payload) {
  // Single-line log so transcripts stay tidy. Real provider will replace.
  console.log(`[mailer:${kind}]`, JSON.stringify({ from: SHOP_FROM, ...payload }));
}

async function sendActivationEmail({ email, token, name }) {
  const url = `${PUBLIC_BASE}/activate/${token}`;
  log('activation', { to: email, name, url });
  // TODO: real send.
  return { ok: true, stub: true };
}

async function sendPasswordResetEmail({ email, token, name }) {
  const url = `${PUBLIC_BASE}/reset-password/${token}`;
  log('password-reset', { to: email, name, url, ttl: '1 hour' });
  return { ok: true, stub: true };
}

async function sendOrderConfirmation({ email, order }) {
  const url = `${PUBLIC_BASE}/order/${order.order_number}`;
  log('order-confirmation', { to: email, order_number: order.order_number, total: order.grand_total, url });
  return { ok: true, stub: true };
}

async function sendProofRequest({ email, order, proof, approvalUrl }) {
  log('proof-request', {
    to: email,
    order_number: order.order_number,
    proof_number: proof.proof_number,
    approval_url: approvalUrl,
  });
  return { ok: true, stub: true };
}

async function sendOrderApproved({ email, order }) {
  log('order-approved', { to: email, order_number: order.order_number });
  return { ok: true, stub: true };
}

async function sendOrderShipped({ email, order }) {
  log('order-shipped', {
    to: email,
    order_number: order.order_number,
    tracking_number: order.tracking_number,
    carrier: order.shipping_carrier,
  });
  return { ok: true, stub: true };
}

async function sendOrderReadyForPickup({ email, order }) {
  log('order-ready-for-pickup', {
    to: email,
    order_number: order.order_number,
    pickup_address: '2-43 Eastridge Rd, Walkerton ON N0G 2V0',
  });
  return { ok: true, stub: true };
}

async function sendOrderRefunded({ email, order, amount }) {
  log('order-refunded', { to: email, order_number: order.order_number, amount });
  return { ok: true, stub: true };
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
};
