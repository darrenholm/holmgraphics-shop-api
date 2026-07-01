// lib/sms.js
// Outbound SMS for the shop — provider-agnostic core.
//
// Today this backs staff job-assignment texts (see lib/employee-notifier.js);
// it's written generic so the later "notify the client" phase reuses the same
// send() without touching provider code.
//
// Provider: SkySwitch (our VoIP reseller platform) via its Messaging API.
//   POST {API_BASE}/accounts/{ACCOUNT_ID}/messaging/send
//   Auth: OAuth2 password grant → bearer token (cached in-process).
// A second provider (Twilio) can be added behind the same send() contract by
// switching SMS_PROVIDER; nothing above this file changes.
//
// ── Setup (SkySwitch) ─────────────────────────────────────────────────────────
//   1. In the SkySwitch Partner Portal (app.skyswitch.com): Manage Accounts →
//      Accounts tab → View the account that owns the sending DID → "API & Relay"
//      tab → Generate an API Access Token. (Self-serve — no Control Tower ticket
//      needed.) While there, set the Relay Webhook only when we build inbound
//      reply handling; it's not needed to send.
//   2. Enable SMS on the DID texts send from (Telco → the number → enable
//      SMS/MMS). That number is SKYSWITCH_SMS_FROM.
//   3. Set these env vars in Railway:
//        SMS_PROVIDER=skyswitch
//        SKYSWITCH_API_TOKEN=...     ← the API Access Token from step 1 (bearer)
//        SKYSWITCH_ACCOUNT_ID=...    ← the account the token belongs to / owns
//                                      the sending DID (used to build the send
//                                      URL: {API_BASE}/accounts/{id}/messaging/send)
//        SKYSWITCH_SMS_FROM=+1519...
//        SKYSWITCH_API_BASE=https://api.skyswitch.com        (default)
//        SKYSWITCH_SEND_URL=...      ← optional: full send URL, overrides the
//                                      {API_BASE}/accounts/{id}/messaging/send
//                                      default if the API & Relay docs differ.
//
//   OAuth alternative: if your account issues OAuth2 (password-grant) creds
//   instead of a static token, leave SKYSWITCH_API_TOKEN blank and set
//   SKYSWITCH_TOKEN_URL + SKYSWITCH_CLIENT_ID + SKYSWITCH_CLIENT_SECRET +
//   SKYSWITCH_API_USER + SKYSWITCH_API_PASSWORD instead; the code fetches and
//   caches a bearer token automatically.
//
// Without complete credentials this module runs in STUB mode: it logs
// `[sms:<kind>]` and returns { ok: true, stub: true } — same fall-back shape
// as customer-mailer.js so dev/staging boot without SMS wired up.
//
// Failure policy: send() NEVER throws. Failures return { ok: false, error }.

'use strict';

const PROVIDER = (process.env.SMS_PROVIDER || 'cloudmessage').toLowerCase();

// CloudMessage — SkySwitch's Business SMS product (powered by Textable). This
// is the chosen provider. Send API: POST https://api.cloudmessage.io/api/send
// with JSON { to, from, message } (all E.164). Auth is a "UserToken"; the docs
// don't pin the header name, so it's configurable — default Authorization:
// Bearer <token>. If a live test 401s, flip SKYSWITCH_AUTH_HEADER /
// SKYSWITCH_AUTH_PREFIX rather than editing code.
//
// Auth (per the CloudMessage/Textable "UserToken" scheme):
//   Authorization: Bearer <accountUid>:<apiKey>
// so BOTH the Account UID (SKYSWITCH_ACCOUNT_ID) and the API token
// (SKYSWITCH_API_TOKEN) are required — they're joined by a colon. Reuses the
// SKYSWITCH_* env you already set so there's nothing to re-key.
const CM = {
  // .trim() guards against a trailing space/newline picked up when the token
  // or UID is copy-pasted out of the portal's web table.
  sendUrl:    (process.env.SKYSWITCH_SEND_URL || 'https://api.cloudmessage.io/api/send').trim(),
  token:      (process.env.SKYSWITCH_API_TOKEN || '').trim(),
  accountUid: (process.env.SKYSWITCH_ACCOUNT_ID || '').trim(),
  from:       (process.env.SKYSWITCH_SMS_FROM  || '').trim(),
  authHeader: (process.env.SKYSWITCH_AUTH_HEADER || 'Authorization').trim(),
  authPrefix: process.env.SKYSWITCH_AUTH_PREFIX !== undefined ? process.env.SKYSWITCH_AUTH_PREFIX : 'Bearer ',
};

function cloudmessageConfigured() {
  return Boolean(CM.token && CM.accountUid && CM.from && CM.sendUrl);
}

const SKY = {
  apiBase:  (process.env.SKYSWITCH_API_BASE || 'https://api.skyswitch.com').replace(/\/$/, ''),
  sendUrl:   process.env.SKYSWITCH_SEND_URL || '',   // optional full override
  token:     process.env.SKYSWITCH_API_TOKEN || '',  // static API Access Token
  tokenUrl:  process.env.SKYSWITCH_TOKEN_URL || '',  // OAuth alternative ↓
  clientId:  process.env.SKYSWITCH_CLIENT_ID || '',
  clientSecret: process.env.SKYSWITCH_CLIENT_SECRET || '',
  apiUser:   process.env.SKYSWITCH_API_USER || '',
  apiPass:   process.env.SKYSWITCH_API_PASSWORD || '',
  accountId: process.env.SKYSWITCH_ACCOUNT_ID || '',
  from:      process.env.SKYSWITCH_SMS_FROM || '',
};

// Two auth modes: a static API Access Token (from the API & Relay tab), or the
// OAuth2 password grant. Either satisfies "we can get a bearer token".
function skyswitchHasAuth() {
  if (SKY.token) return true;
  return Boolean(SKY.tokenUrl && SKY.clientId && SKY.clientSecret && SKY.apiUser && SKY.apiPass);
}

function skyswitchConfigured() {
  // Need auth, a sending number, and a way to build the send URL (either the
  // explicit override or an account id to slot into the default path).
  return Boolean(skyswitchHasAuth() && SKY.from && (SKY.sendUrl || SKY.accountId));
}

// Is a real provider fully configured? If not, send() runs in stub mode.
function isConfigured() {
  if (PROVIDER === 'cloudmessage') return cloudmessageConfigured();
  if (PROVIDER === 'skyswitch') return skyswitchConfigured();
  return false; // twilio adapter not wired yet
}

// ── Phone normalization ───────────────────────────────────────────────────────
// Return E.164 (+1XXXXXXXXXX) for North-American numbers, or null if the input
// clearly isn't a dialable 10/11-digit number. Employees enter numbers however
// they like (519-555-0123, (519) 555 0123, etc.); we tidy here so callers don't.
function toE164(raw) {
  if (!raw) return null;
  const digits = String(raw).replace(/[^\d]/g, '');
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits[0] === '1') return `+${digits}`;
  if (String(raw).trim().startsWith('+')) return `+${digits}`; // already intl
  return null;
}

// ── SkySwitch bearer token ─────────────────────────────────────────────────────
// If a static API Access Token is configured, use it verbatim. Otherwise run
// the OAuth2 password grant and cache the access_token until ~a minute before
// expiry; on any failure we clear the cache so the next send re-authenticates.
let _token = null;      // { value, expiresAtMs }

async function skyswitchToken() {
  if (SKY.token) return SKY.token;

  const now = Date.now();
  if (_token && _token.expiresAtMs > now + 60_000) return _token.value;

  const body = new URLSearchParams({
    grant_type: 'password',
    client_id: SKY.clientId,
    client_secret: SKY.clientSecret,
    username: SKY.apiUser,
    password: SKY.apiPass,
  });

  const res = await fetch(SKY.tokenUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  });
  if (!res.ok) {
    _token = null;
    const detail = await res.text().catch(() => '');
    throw new Error(`skyswitch token ${res.status}: ${detail.slice(0, 300)}`);
  }
  const json = await res.json();
  const value = json.access_token;
  if (!value) {
    _token = null;
    throw new Error('skyswitch token response missing access_token');
  }
  const ttlMs = (Number(json.expires_in) || 3600) * 1000;
  _token = { value, expiresAtMs: now + ttlMs };
  return value;
}

async function skyswitchSend({ to, body, refId }) {
  const token = await skyswitchToken();
  const url = SKY.sendUrl ||
    `${SKY.apiBase}/accounts/${encodeURIComponent(SKY.accountId)}/messaging/send`;
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      source_number: SKY.from,
      destination: to,
      message: body,
      ...(refId ? { ref_id: String(refId) } : {}),
    }),
  });
  const text = await res.text().catch(() => '');
  if (!res.ok) {
    // A 401 usually means the cached token went stale server-side; drop it so
    // the next attempt re-authenticates.
    if (res.status === 401) _token = null;
    return { ok: false, error: `skyswitch send ${res.status}: ${text.slice(0, 300)}` };
  }
  let messageId = null;
  try { messageId = JSON.parse(text)?.id || JSON.parse(text)?.message_id || null; } catch (_) {}
  return { ok: true, provider: 'skyswitch', message_id: messageId };
}

// CloudMessage send: POST { to, from, message } to api.cloudmessage.io/api/send
// with the UserToken in the (configurable) auth header. `to`/`from` are E.164.
async function cloudmessageSend({ to, body }) {
  const from = toE164(CM.from) || CM.from;
  // Auth credential is "<accountUid>:<apiKey>" (or just the token if no UID),
  // prefixed with the scheme word. .trim() guards a trailing-space env typo;
  // an empty prefix sends the bare credential.
  const credential = CM.accountUid ? `${CM.accountUid}:${CM.token}` : CM.token;
  const prefix = CM.authPrefix.trim();
  const authValue = prefix ? `${prefix} ${credential}` : credential;
  const res = await fetch(CM.sendUrl, {
    method: 'POST',
    headers: {
      [CM.authHeader]: authValue,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ to, from, message: body }),
  });
  const text = await res.text().catch(() => '');
  if (!res.ok) {
    return { ok: false, error: `cloudmessage send ${res.status}: ${text.slice(0, 300)}` };
  }
  let messageId = null;
  try {
    const j = JSON.parse(text);
    messageId = j.id || j.messageId || j.message_id || j.uuid || null;
  } catch (_) {}
  return { ok: true, provider: 'cloudmessage', message_id: messageId };
}

// ── Public send() ─────────────────────────────────────────────────────────────
// { to, body, kind, refId } → { ok, provider?, message_id?, error?, stub? }
// `to` is normalized to E.164 here. Never throws.
async function send({ to, body, kind, refId }) {
  const dest = toE164(to);
  if (!dest) {
    console.warn(`[sms:${kind}] unusable destination number:`, to);
    return { ok: false, error: 'invalid_destination' };
  }
  if (!body || !String(body).trim()) {
    return { ok: false, error: 'empty_body' };
  }

  if (!isConfigured()) {
    console.log(`[sms:${kind}]`, JSON.stringify({ provider: 'stub', to: dest, body }));
    return { ok: true, provider: 'stub', stub: true };
  }

  try {
    if (PROVIDER === 'cloudmessage') {
      return await cloudmessageSend({ to: dest, body });
    }
    if (PROVIDER === 'skyswitch') {
      return await skyswitchSend({ to: dest, body, refId });
    }
    return { ok: false, error: `unknown SMS_PROVIDER: ${PROVIDER}` };
  } catch (err) {
    console.warn(`[sms:${kind}] send failed:`, err.message);
    return { ok: false, error: err.message };
  }
}

module.exports = {
  send,
  isConfigured,
  toE164,
  _internals: { PROVIDER, skyswitchConfigured, cloudmessageConfigured },
};
