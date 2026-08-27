// lib/stripe-client.js
// Lazily-constructed Stripe SDK singleton for the counter POS (Stripe
// Terminal) and, later, online checkout.
//
// Lazy on purpose: server.js requires every route module at boot, and the
// API runs in environments where STRIPE_SECRET_KEY isn't set (local dev on
// someone else's machine, the migration CLI). Constructing at require-time
// would turn a missing variable into a boot crash for the whole API rather
// than a 503 on the two routes that actually need it.
//
// STRIPE_SECRET_KEY lives in Railway variables ONLY. Do not add it to a
// committed .env — this repo has prior history of a committed .env and
// these are live-money keys.

'use strict';

const Stripe = require('stripe');

// Pin the API version so a Stripe-side default bump can't change the shape
// of a webhook payload under a running till. Update deliberately, with the
// changelog open.
const STRIPE_API_VERSION = '2026-08-26.dahlia';

let _stripe = null;

function stripeConfigured() {
  return !!process.env.STRIPE_SECRET_KEY;
}

function getStripe() {
  if (_stripe) return _stripe;
  const key = process.env.STRIPE_SECRET_KEY;
  if (!key) {
    throw new Error(
      'STRIPE_SECRET_KEY is not set. Add it to the Railway variables for this service.'
    );
  }
  _stripe = new Stripe(key, {
    apiVersion: STRIPE_API_VERSION,
    // Terminal round-trips happen with a customer standing at the counter.
    // Fail fast and let the tablet retry rather than hanging the till.
    timeout: 20_000,
    maxNetworkRetries: 2,
    appInfo: { name: 'holmgraphics-shop-api', url: 'https://api.holmgraphics.ca' },
  });
  return _stripe;
}

// Live vs test is a property of the key, not a separate flag. The tablet
// asks for this at startup so `initialize({ isTest })` can't drift out of
// sync with whichever key the server is actually holding — a mismatch there
// produces an opaque "reader not found" rather than an auth error.
function isTestMode() {
  return !String(process.env.STRIPE_SECRET_KEY || '').startsWith('sk_live_');
}

// The Terminal Location the WisePad 3 binds to at connect time. Created once
// per shop location — see TERMINAL_POS.md §Setup.
function terminalLocationId() {
  return process.env.STRIPE_TERMINAL_LOCATION_ID || null;
}

// Reset hook for tests that swap the env between cases.
function _resetForTests() {
  _stripe = null;
}

module.exports = {
  STRIPE_API_VERSION,
  getStripe,
  stripeConfigured,
  isTestMode,
  terminalLocationId,
  _resetForTests,
};
