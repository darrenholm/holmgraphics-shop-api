// lib/smartcar-client.js
// Thin wrapper around the official `smartcar` Node SDK. Centralizes config
// + the CSRF state-token signing so route handlers don't reach for
// `process.env` directly.
//
// Required env (see Phase 2 spec):
//   SMARTCAR_CLIENT_ID
//   SMARTCAR_CLIENT_SECRET
//   SMARTCAR_REDIRECT_URI       e.g. https://api.holmgraphics.ca/api/fleet/smartcar/callback
//   SMARTCAR_MODE               'test' (default) or 'live'
//   SMARTCAR_MAX_VEHICLES       optional, default 25 — hard cap on linked vehicles
//   JWT_SECRET                  reused for stateless OAuth state CSRF tokens
//
// Test mode defaults to 'test' so a misconfigured env never connects a
// real truck — flip to 'live' explicitly after a green simulator run.

'use strict';

const jwt = require('jsonwebtoken');
const smartcar = require('smartcar');

const SCOPES = ['read_vehicle_info', 'read_location', 'read_odometer', 'read_fuel'];
const STATE_TTL_SECONDS = 10 * 60;          // 10 min — generous for slow OAuth flows
const DEFAULT_MAX_VEHICLES = 25;

function getMode() {
  // Smartcar SDK accepts 'live' | 'test' | 'simulated'.
  //   'live'      — production: real OEM auth, real vehicles, billable.
  //   'simulated' — Connect 2.0 simulator: same flow as live but lets the
  //                 buyer pick a simulated vehicle you set up in the
  //                 dashboard's Simulator section. Non-billable, full
  //                 round-trip. **This is what new apps use.**
  //   'test'      — legacy Connect 1.0 test mode. Rejected by new apps
  //                 with "Invalid parameter client_id" at the OAuth step.
  // Default to 'simulated' so a freshly-created app works out of the
  // box without burning real Smartcar calls.
  const m = (process.env.SMARTCAR_MODE || '').toLowerCase();
  if (m === 'live')      return 'live';
  if (m === 'test')      return 'test';
  return 'simulated';
}

function getMaxVehicles() {
  const raw = parseInt(process.env.SMARTCAR_MAX_VEHICLES, 10);
  return Number.isInteger(raw) && raw > 0 ? raw : DEFAULT_MAX_VEHICLES;
}

function isConfigured() {
  return !!(process.env.SMARTCAR_CLIENT_ID && process.env.SMARTCAR_CLIENT_SECRET && process.env.SMARTCAR_REDIRECT_URI);
}

let _authClient = null;
function authClient() {
  if (!isConfigured()) {
    const e = new Error('Smartcar is not configured: set SMARTCAR_CLIENT_ID / SECRET / REDIRECT_URI.');
    e.code = 'SMARTCAR_NOT_CONFIGURED';
    throw e;
  }
  if (!_authClient) {
    _authClient = new smartcar.AuthClient({
      clientId:     process.env.SMARTCAR_CLIENT_ID,
      clientSecret: process.env.SMARTCAR_CLIENT_SECRET,
      redirectUri:  process.env.SMARTCAR_REDIRECT_URI,
      mode:         getMode()
    });
  }
  return _authClient;
}

// ─── CSRF state token ───────────────────────────────────────────────────────
// Stateless: signed JWT with the user id + the vehicle being connected.
// On callback we verify the signature, the expiry, and that the payload
// shape matches. No server-side store needed.

function signState({ userId, vehicleId }) {
  if (!process.env.JWT_SECRET) {
    const e = new Error('JWT_SECRET not set — cannot sign Smartcar state token.');
    e.code = 'JWT_SECRET_MISSING';
    throw e;
  }
  return jwt.sign(
    { sub: userId, vid: vehicleId, kind: 'smartcar_state' },
    process.env.JWT_SECRET,
    { expiresIn: STATE_TTL_SECONDS }
  );
}

function verifyState(stateToken) {
  if (!stateToken) {
    const e = new Error('Missing state parameter on OAuth callback.');
    e.code = 'STATE_MISSING';
    throw e;
  }
  let payload;
  try {
    payload = jwt.verify(stateToken, process.env.JWT_SECRET);
  } catch (err) {
    const e = new Error('Invalid or expired OAuth state.');
    e.code = 'STATE_INVALID';
    throw e;
  }
  if (payload.kind !== 'smartcar_state') {
    const e = new Error('OAuth state token has the wrong kind.');
    e.code = 'STATE_KIND_MISMATCH';
    throw e;
  }
  return payload;
}

// ─── Authorization URL ──────────────────────────────────────────────────────

function getAuthUrl({ userId, vehicleId }) {
  const state = signState({ userId, vehicleId });
  // testMode is the Connect 1.0 flag; for new apps the mode is set on
  // AuthClient construction and the SDK handles the URL params from there.
  const url = authClient().getAuthUrl(SCOPES, {
    state,
    forcePrompt: true,
    testMode: getMode() === 'test'    // only true for legacy apps explicitly opted in
  });
  return { url, state };
}

// ─── Token exchange + refresh ───────────────────────────────────────────────

async function exchangeCode(code) {
  // smartcar SDK returns { accessToken, refreshToken, expiration, refreshExpiration }
  const tokens = await authClient().exchangeCode(code);
  return tokens;
}

async function refreshAccess(refreshToken) {
  const tokens = await authClient().exchangeRefreshToken(refreshToken);
  return tokens;
}

// ─── Vehicle helpers ────────────────────────────────────────────────────────

async function listVehicles(accessToken) {
  // Returns { vehicles: [ids], paging }. We just need the id list.
  const result = await smartcar.getVehicles(accessToken);
  return result.vehicles || [];
}

function vehicle(smartcarVehicleId, accessToken) {
  return new smartcar.Vehicle(smartcarVehicleId, accessToken);
}

async function getVehicleVin(smartcarVehicleId, accessToken) {
  const v = vehicle(smartcarVehicleId, accessToken);
  const { vin } = await v.vin();
  return vin;
}

async function getVehicleAttributes(smartcarVehicleId, accessToken) {
  const v = vehicle(smartcarVehicleId, accessToken);
  return v.attributes();   // { id, make, model, year }
}

async function getVehicleLocation(smartcarVehicleId, accessToken) {
  const v = vehicle(smartcarVehicleId, accessToken);
  const loc = await v.location();
  // { data: { latitude, longitude }, meta: { dataAge?, requestId, unitSystem } }
  // The SDK returns top-level latitude/longitude; meta carries timestamp metadata.
  return loc;
}

async function getVehicleOdometer(smartcarVehicleId, accessToken) {
  try {
    const v = vehicle(smartcarVehicleId, accessToken);
    const r = await v.odometer();    // { distance, meta }
    return r;
  } catch (e) {
    // not every vehicle exposes odometer; treat as soft-fail
    return null;
  }
}

async function getVehicleFuel(smartcarVehicleId, accessToken) {
  try {
    const v = vehicle(smartcarVehicleId, accessToken);
    const r = await v.fuel();        // { range, percentRemaining, amountRemaining, meta }
    return r;
  } catch (e) {
    return null;
  }
}

async function revoke(smartcarVehicleId, accessToken) {
  try {
    const v = vehicle(smartcarVehicleId, accessToken);
    await v.disconnect();
    return true;
  } catch (e) {
    return false;
  }
}

module.exports = {
  isConfigured,
  getMode,
  getMaxVehicles,
  SCOPES,

  // CSRF state
  signState,
  verifyState,

  // OAuth
  getAuthUrl,
  exchangeCode,
  refreshAccess,

  // Per-vehicle calls
  listVehicles,
  getVehicleVin,
  getVehicleAttributes,
  getVehicleLocation,
  getVehicleOdometer,
  getVehicleFuel,
  revoke
};
