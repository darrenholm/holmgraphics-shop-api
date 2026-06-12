// lib/fordconnect.js
// Wrapper around Ford's FordConnect API. Two responsibilities:
//   1. OAuth (Azure AD B2C) — authorize URL builder, code exchange,
//      refresh-token rotation
//   2. Authenticated GETs — /garage, /telemetry, /vehicle-health/alerts
//
// The Azure B2C peculiarities to remember:
//   • The OAuth scope is literally the client_id + " offline_access openid".
//     B2C uses the app's own client_id as the resource scope identifier.
//   • The same /token endpoint serves both authorization_code and
//     refresh_token grants; only the body differs.
//   • B2C wants form-urlencoded bodies, NOT JSON, on the token endpoint.
//
// Keep all Ford-specific URLs and quirks in this one module so the routes
// stay clean.

'use strict';

const BASE_OAUTH = 'https://api.vehicle.ford.com/dah2vb2cprod.onmicrosoft.com/oauth2/v2.0';
const BASE_API   = 'https://api.vehicle.ford.com/fcon-query/v1';
const POLICY     = 'B2C_1A_FCON_AUTHORIZE';

const CLIENT_ID     = process.env.FORDCONNECT_CLIENT_ID || '';
const CLIENT_SECRET = process.env.FORDCONNECT_CLIENT_SECRET || '';
const REDIRECT_URI  = process.env.FORDCONNECT_REDIRECT_URI || '';

function isConfigured() {
  return Boolean(CLIENT_ID && CLIENT_SECRET && REDIRECT_URI);
}

// Per Azure B2C: the scope identifier IS the client_id, plus the standard
// OIDC scopes for refresh tokens and ID tokens.
function defaultScope() {
  return `${CLIENT_ID} offline_access openid`;
}

// Build the URL we redirect the user to so they can log into FordPass and
// grant access. State is opaque to Ford — we use it as a CSRF nonce that
// gets bounced back to our callback for verification.
function authorizeUrl({ state }) {
  if (!isConfigured()) throw new Error('FordConnect not configured');
  const u = new URL(`${BASE_OAUTH}/authorize`);
  u.searchParams.set('p',             POLICY);
  u.searchParams.set('client_id',     CLIENT_ID);
  u.searchParams.set('redirect_uri',  REDIRECT_URI);
  u.searchParams.set('response_type', 'code');
  u.searchParams.set('scope',         defaultScope());
  u.searchParams.set('state',         state);
  return u.toString();
}

async function postForm(body) {
  const url = `${BASE_OAUTH}/token?p=${POLICY}`;
  const r = await fetch(url, {
    method:  'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body:    new URLSearchParams(body).toString(),
  });
  const json = await r.json().catch(() => null);
  if (!r.ok || !json?.access_token) {
    const msg = json?.error_description || json?.error || `HTTP ${r.status}`;
    throw new Error(`Ford token endpoint: ${msg}`);
  }
  return json;
}

// Exchange the ?code=... we got at /callback for an access + refresh token.
async function exchangeCode(code) {
  return postForm({
    grant_type:    'authorization_code',
    code,
    redirect_uri:  REDIRECT_URI,
    client_id:     CLIENT_ID,
    client_secret: CLIENT_SECRET,
    scope:         defaultScope(),
  });
}

// Trade an old refresh_token for a fresh access_token (and a new
// refresh_token — Ford rotates them on every refresh).
async function refreshTokens(refreshToken) {
  return postForm({
    grant_type:    'refresh_token',
    refresh_token: refreshToken,
    redirect_uri:  REDIRECT_URI,
    client_id:     CLIENT_ID,
    client_secret: CLIENT_SECRET,
    scope:         defaultScope(),
  });
}

// Authenticated GET to any /fcon-query/v1/<path> endpoint. Caller passes
// the path WITHOUT the base URL (e.g. "telemetry", "garage").
async function apiGet(accessToken, path) {
  const r = await fetch(`${BASE_API}/${path}`, {
    headers: {
      'Authorization': `Bearer ${accessToken}`,
      'Accept':        'application/json',
    },
  });
  const json = await r.json().catch(() => null);
  if (!r.ok) {
    const msg = json?.message || json?.error || `HTTP ${r.status}`;
    const err = new Error(`Ford ${path}: ${msg}`);
    err.status = r.status;
    throw err;
  }
  return json;
}

// Friendly wrappers — keep route code from having to know endpoint paths.
const getGarage   = (tok) => apiGet(tok, 'garage');
const getTelemetry = (tok) => apiGet(tok, 'telemetry');
const getAlerts    = (tok) => apiGet(tok, 'vehicle-health/alerts');

module.exports = {
  isConfigured,
  authorizeUrl,
  exchangeCode,
  refreshTokens,
  apiGet,
  getGarage, getTelemetry, getAlerts,
};
