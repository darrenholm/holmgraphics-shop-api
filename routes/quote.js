// routes/quote.js
//
// Public quote-request endpoint, called by the marketing homepage form.
//
//   POST /api/quote-request
//     Body: { name, email, company?, phone?, service?, details?, _website? }
//     Returns: { ok: true } on success, { error } on validation failure.
//
// No auth -- this is a public form anyone on holmgraphics.ca can submit.
// CORS is already permissive for the apex (set in server.js / Railway env).
//
// Spam strategy: honeypot field. The frontend renders a hidden input
// named `_website` that real humans never see (visibility:hidden, off
// screen). Bots scraping the form usually fill every visible input.
// If `_website` is non-empty when the request arrives, we silently
// return success (so the bot thinks it succeeded) and don't send any
// email. Cheap, no UX cost, defeats most low-effort spam. If we ever
// see real spam getting through, layer on rate limiting or hCaptcha.
//
// We send TWO emails on success:
//   1. Notification to staff (SHOP_QUOTES_TO).
//   2. Acknowledgement to the customer.
// Mailer failures don't block the response -- the customer sees ok=true
// either way. If the staff notification fails it gets logged for retry.

'use strict';

const express = require('express');
const mailer  = require('../lib/customer-mailer');

const router = express.Router();

function isLikelyEmail(s) {
  return typeof s === 'string' && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s.trim());
}

function trim(s, max) {
  return typeof s === 'string' ? s.trim().slice(0, max) : '';
}

router.post('/', async (req, res) => {
  // Honeypot: if a bot filled this hidden field, swallow the submission.
  // Return 200 so the bot moves on without retrying.
  if (req.body?._website) {
    return res.json({ ok: true });
  }

  const name    = trim(req.body?.name,    100);
  const company = trim(req.body?.company, 200);
  const email   = trim(req.body?.email,   200);
  const phone   = trim(req.body?.phone,    50);
  const service = trim(req.body?.service, 100);
  const details = trim(req.body?.details, 4000);

  if (!isLikelyEmail(email)) {
    return res.status(400).json({ error: 'A valid email is required.' });
  }
  if (!name && !company) {
    return res.status(400).json({ error: 'Tell us your name or company.' });
  }

  // Fire the staff notification first (the one that matters). Customer
  // ack is a nice-to-have -- if it fails we still tell the customer "ok"
  // because their request DID land in our inbox.
  const notify = await mailer.sendQuoteRequestNotification({
    name, company, email, phone, service, details,
  });
  if (!notify.ok) {
    console.error('[quote-request] staff notification failed:', notify.error);
    // Even though the email failed, return ok so the customer sees the
    // success state -- their next move (call us) is the real fallback,
    // and we have the failure in logs to follow up on.
  }

  mailer.sendQuoteRequestAck({ email, name }).catch((e) =>
    console.warn('[quote-request] customer ack failed:', e.message)
  );

  res.json({ ok: true });
});

module.exports = router;
