// lib/qbo-tokens.js
// Shared QBO OAuth token management. Used by both routes/quickbooks.js
// (the connect/disconnect/invoice flow) and lib/qb-payments.js (the QB
// Payments charge/refund flow). Both share the same access token and
// refresh token because Intuit issues a single token pair per app per
// realm that's valid across all granted scopes.
//
// Tokens live in the qbo_tokens table (migration 007). On-demand refresh:
// activeTokens() returns a live token pair and refreshes if within 60s of
// expiry. Refresh updates the DB row in the same call so subsequent calls
// from any process / dyno see the new pair.

'use strict';

const { query, queryOne } = require('../db/connection');

const QB_TOKEN_URL = 'https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer';

// Single source of truth for what scopes the app currently asks for.
// Update here AND nowhere else when adding more scopes — routes/quickbooks.js
// imports this constant for the OAuth /connect redirect.
const REQUIRED_SCOPES = 'com.intuit.quickbooks.accounting com.intuit.quickbooks.payment';

async function getTokens() {
  const row = await queryOne(
    `SELECT realm_id, access_token, refresh_token, expires_at, scopes
       FROM qbo_tokens
      ORDER BY updated_at DESC
      LIMIT 1`
  );
  if (!row) return null;
  return {
    realm_id:      row.realm_id,
    access_token:  row.access_token,
    refresh_token: row.refresh_token,
    expires_at:    row.expires_at instanceof Date ? row.expires_at.toISOString() : row.expires_at,
    scopes:        row.scopes,
  };
}

async function saveTokens(t) {
  await query(
    `INSERT INTO qbo_tokens (realm_id, access_token, refresh_token, expires_at, scopes)
       VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (realm_id) DO UPDATE SET
       access_token  = EXCLUDED.access_token,
       refresh_token = EXCLUDED.refresh_token,
       expires_at    = EXCLUDED.expires_at,
       scopes        = EXCLUDED.scopes`,
    [
      t.realm_id,
      t.access_token,
      t.refresh_token,
      t.expires_at,
      t.scopes || REQUIRED_SCOPES,
    ]
  );
}

async function clearTokens() {
  await query(`DELETE FROM qbo_tokens`);
}

function hasRequiredScopes(storedScopes) {
  if (!storedScopes) return false;
  const have = new Set(storedScopes.split(/\s+/).filter(Boolean));
  return REQUIRED_SCOPES.split(/\s+/).filter(Boolean).every((s) => have.has(s));
}

async function refreshAccessToken(tokens) {
  const creds = Buffer.from(
    `${process.env.QB_CLIENT_ID}:${process.env.QB_CLIENT_SECRET}`
  ).toString('base64');

  const res = await fetch(QB_TOKEN_URL, {
    method: 'POST',
    headers: {
      'Authorization': `Basic ${creds}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams({
      grant_type:    'refresh_token',
      refresh_token: tokens.refresh_token,
    }),
  });
  if (!res.ok) throw new Error('QBO token refresh failed');

  const data = await res.json();
  const updated = {
    realm_id:      tokens.realm_id,
    access_token:  data.access_token,
    refresh_token: data.refresh_token || tokens.refresh_token,
    expires_at:    new Date(Date.now() + data.expires_in * 1000).toISOString(),
    scopes:        tokens.scopes,
  };
  await saveTokens(updated);
  return updated;
}

async function activeTokens() {
  let t = await getTokens();
  if (!t) throw new Error('QuickBooks not connected');
  if (new Date(t.expires_at) <= new Date(Date.now() + 60_000)) {
    t = await refreshAccessToken(t);
  }
  return t;
}

module.exports = {
  REQUIRED_SCOPES,
  QB_TOKEN_URL,
  getTokens,
  saveTokens,
  clearTokens,
  hasRequiredScopes,
  refreshAccessToken,
  activeTokens,
};
