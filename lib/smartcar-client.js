// lib/smartcar-client.js
// Smartcar Connect 2.0 / V3 integration. Talks to three Smartcar hosts:
//
//   iam.smartcar.com         — token endpoint (both M2M and code exchange)
//   connect.smartcar.com     — user-facing authorize UI
//   vehicle.api.smartcar.com — V3 data API (connections, signals, etc.)
//
// V3 auth model: ONE M2M access token per application (client_credentials
// grant), cached for ~1h. Per-user scoping happens via the `sc-user-id`
// header on data requests, not via per-user OAuth tokens.
//
// Why we don't use the `smartcar` Node SDK any more: it targets the V2
// endpoints (`auth.smartcar.com`, per-user tokens). The V3 endpoints +
// auth model are incompatible with the SDK's URL/header structure.
// Direct fetch calls are simpler than monkey-patching the SDK.
//
// Env vars (see Phase 2 docs):
//   SMARTCAR_APPLICATION_ID  UUID, used in the authorize URL as application_id
//   SMARTCAR_CLIENT_ID       client_<ULID>, used for Basic auth at iam.smartcar.com
//   SMARTCAR_CLIENT_SECRET   paired with CLIENT_ID
//   SMARTCAR_REDIRECT_URI    the public callback URL (must match dashboard)
//   SMARTCAR_MODE            'live' | 'simulated' | 'test' (default 'simulated')
//   JWT_SECRET               reused to sign OAuth state tokens (CSRF)

'use strict';

const jwt = require('jsonwebtoken');

const IAM_BASE        = 'https://iam.smartcar.com';
const CONNECT_BASE    = 'https://connect.smartcar.com';
const VEHICLE_API     = 'https://vehicle.api.smartcar.com';
const STATE_TTL_SEC   = 10 * 60;
const DEFAULT_MAX_VEH = 25;
const M2M_REFRESH_BUF_MS = 60 * 1000;            // refresh 60s before expiry

const SCOPES = ['read_vehicle_info', 'read_location', 'read_odometer', 'read_fuel'];

// ─── config getters ────────────────────────────────────────────────────────

function getApplicationId() {
  return process.env.SMARTCAR_APPLICATION_ID || process.env.SMARTCAR_CLIENT_ID;
}
function getClientId()     { return process.env.SMARTCAR_CLIENT_ID; }
function getClientSecret() { return process.env.SMARTCAR_CLIENT_SECRET; }
function getRedirectUri()  { return process.env.SMARTCAR_REDIRECT_URI; }
function getMode() {
  const m = (process.env.SMARTCAR_MODE || '').toLowerCase();
  if (m === 'live')      return 'live';
  if (m === 'test')      return 'test';
  return 'simulated';
}
function getMaxVehicles() {
  const n = parseInt(process.env.SMARTCAR_MAX_VEHICLES, 10);
  return Number.isInteger(n) && n > 0 ? n : DEFAULT_MAX_VEH;
}
function isConfigured() {
  return !!(getApplicationId() && getClientId() && getClientSecret() && getRedirectUri());
}

function basicAuthHeader() {
  return 'Basic ' + Buffer.from(`${getClientId()}:${getClientSecret()}`).toString('base64');
}

// ─── CSRF state JWT (unchanged from V2) ────────────────────────────────────

function signState({ userId, vehicleId }) {
  if (!process.env.JWT_SECRET) {
    const e = new Error('JWT_SECRET not set');
    e.code = 'JWT_SECRET_MISSING';
    throw e;
  }
  return jwt.sign(
    { sub: userId, vid: vehicleId, kind: 'smartcar_state' },
    process.env.JWT_SECRET,
    { expiresIn: STATE_TTL_SEC }
  );
}
function verifyState(token) {
  if (!token) { const e = new Error('state missing'); e.code = 'STATE_MISSING'; throw e; }
  let payload;
  try { payload = jwt.verify(token, process.env.JWT_SECRET); }
  catch { const e = new Error('Invalid or expired OAuth state.'); e.code = 'STATE_INVALID'; throw e; }
  if (payload.kind !== 'smartcar_state') {
    const e = new Error('OAuth state kind mismatch.'); e.code = 'STATE_KIND_MISMATCH'; throw e;
  }
  return payload;
}

// ─── Authorize URL — same as before, uses application_id ───────────────────

function getAuthUrl({ userId, vehicleId }) {
  if (!isConfigured()) {
    const e = new Error('Smartcar not configured.');
    e.code = 'SMARTCAR_NOT_CONFIGURED';
    throw e;
  }
  const state = signState({ userId, vehicleId });
  const params = new URLSearchParams({
    response_type:   'code',
    application_id:  getApplicationId(),
    redirect_uri:    getRedirectUri(),
    scope:           SCOPES.join(' '),
    state,
    mode:            getMode(),
    approval_prompt: 'force'
  });
  return { url: `${CONNECT_BASE}/oauth/authorize?${params}`, state };
}

// ─── M2M token (cached) ────────────────────────────────────────────────────
// One token per app, ~1h TTL. We keep it warm so per-request latency stays
// low. Cache is in-memory (process-local); fine for a single Railway dyno.

let _m2mCache = null;        // { token, expiresAt }

async function getM2MToken() {
  if (_m2mCache && Date.now() < _m2mCache.expiresAt - M2M_REFRESH_BUF_MS) {
    return _m2mCache.token;
  }
  const res = await fetch(`${IAM_BASE}/oauth2/token`, {
    method: 'POST',
    headers: { Authorization: basicAuthHeader(), 'Content-Type': 'application/x-www-form-urlencoded' },
    body:    'grant_type=client_credentials'
  });
  const body = await res.text();
  if (!res.ok) throw new Error(`M2M token request failed (${res.status}): ${body}`);
  let json;
  try { json = JSON.parse(body); } catch { throw new Error(`M2M token response not JSON: ${body}`); }
  _m2mCache = {
    token:     json.access_token,
    expiresAt: Date.now() + (Number(json.expires_in) || 3600) * 1000
  };
  return _m2mCache.token;
}

// ─── Authorization code exchange ───────────────────────────────────────────
// Called from the OAuth callback to finalize the user's vehicle authorization.
// Returns whatever the iam.smartcar.com endpoint hands back (typically an
// access_token + refresh_token tied to the user/connection, plus a user_id
// or similar). We don't strictly need the per-user token for subsequent
// fetches — M2M + sc-user-id handles those — but we keep the response in
// case we need any of its fields (e.g. immediate user_id).

async function exchangeCode(code) {
  const body = new URLSearchParams({
    grant_type:   'authorization_code',
    code,
    redirect_uri: getRedirectUri()
  });
  const res = await fetch(`${IAM_BASE}/oauth2/token`, {
    method: 'POST',
    headers: { Authorization: basicAuthHeader(), 'Content-Type': 'application/x-www-form-urlencoded' },
    body
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`code exchange failed (${res.status}): ${text}`);
  try { return JSON.parse(text); } catch { return { raw: text }; }
}

// ─── V3 data API helpers ───────────────────────────────────────────────────

async function v3Get(path, { userId } = {}) {
  const token = await getM2MToken();
  const headers = { Authorization: `Bearer ${token}` };
  if (userId) headers['sc-user-id'] = userId;
  const res = await fetch(`${VEHICLE_API}${path}`, { headers });
  const text = await res.text();
  if (!res.ok) {
    const e = new Error(`Smartcar V3 GET ${path} failed (${res.status}): ${text}`);
    e.status = res.status;
    e.body = text;
    throw e;
  }
  try { return JSON.parse(text); } catch { return { raw: text }; }
}

// List all connections (vehicles authorized to the application). Optionally
// filter to a specific Smartcar user via the sc-user-id header.
async function listConnections({ userId, pageSize = 100 } = {}) {
  const q = new URLSearchParams({ 'page[size]': String(pageSize) });
  const json = await v3Get(`/v3/connections?${q}`, { userId });
  return json.data || [];
}

// Fetch the PreciseLocation signal for one vehicle. sc_user_id is required
// in the header — Smartcar uses it to enforce that the requesting app only
// reads vehicles the user has authorized.
async function fetchLocation({ scVehicleId, scUserId }) {
  return v3Get(`/v3/vehicles/${encodeURIComponent(scVehicleId)}/signals/location-preciselocation`, { userId: scUserId });
}

// ─── module surface ───────────────────────────────────────────────────────

module.exports = {
  isConfigured,
  getMode,
  getMaxVehicles,
  SCOPES,

  // CSRF
  signState,
  verifyState,

  // OAuth
  getAuthUrl,
  exchangeCode,

  // V3 data
  getM2MToken,
  listConnections,
  fetchLocation
};
