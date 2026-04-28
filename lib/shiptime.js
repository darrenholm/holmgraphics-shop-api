// lib/shiptime.js
// ShipTime REST API client. Two operations matter for the DTF online store:
//
//   1. quoteRates(rateRequest)   → list of carrier+service quotes
//   2. createShipment(shipReq)   → books a shipment, returns label URL
//
// Both happen in our backend (never the browser) since the ShipTime API
// auth shouldn't be exposed and the bridge receives quotes pre-filtered to
// what we want to show the customer.
//
// Auth: ShipTime production uses OAuth2 client_credentials flow per their
// support docs (article 42000053484). Sandbox uses HTTP Basic with the
// SAME pair of env vars; if SHIPTIME_AUTH_MODE=basic is set we'll use
// Basic instead of OAuth, so a single .env can target either env.
//   - Production: SHIPTIME_BASE_URL=https://restapi.shiptime.com/rest
//                 SHIPTIME_CLIENT_ID=stcid_...
//                 SHIPTIME_API_SECRET=...
//                 (OAuth used by default)
//   - Sandbox:    SHIPTIME_BASE_URL=https://sandboxapi.shiptime.com/rest
//                 SHIPTIME_AUTH_MODE=basic
// Token endpoint defaults to {host}/oauth/token; override with
// SHIPTIME_OAUTH_URL if ShipTime later moves it.
//
// All money fields in ShipTime are CENTS (e.g. $14.50 → { amount: 1450,
// currency: 'CAD' }). We convert to dollars at the boundary so callers
// only deal with dollars.
//
// IMPORTANT: ShipTime quoteIds are valid for ~15 minutes. Re-quote at
// shipment creation time rather than relying on a stale checkout-time id.

'use strict';

const SHIPTIME_BASE_URL = process.env.SHIPTIME_BASE_URL || 'https://restapi.shiptime.com/rest';
const SHIPTIME_CLIENT_ID  = process.env.SHIPTIME_CLIENT_ID  || '';
const SHIPTIME_API_SECRET = process.env.SHIPTIME_API_SECRET || '';
const SHIPTIME_AUTH_MODE  = (process.env.SHIPTIME_AUTH_MODE || 'oauth').toLowerCase();

// OAuth token endpoint. ShipTime production uses /oauth2/token (with the
// "2" — empirically verified; /oauth/token returns 401 from a generic
// auth filter while /oauth2/token returns 405 to a GET, confirming it
// exists and accepts POST). Override with SHIPTIME_OAUTH_URL if it ever
// moves.
function defaultOauthUrl() {
  try {
    const u = new URL(SHIPTIME_BASE_URL);
    return `${u.protocol}//${u.host}/oauth2/token`;
  } catch { return 'https://restapi.shiptime.com/oauth2/token'; }
}
const SHIPTIME_OAUTH_URL = process.env.SHIPTIME_OAUTH_URL || defaultOauthUrl();

// In-memory token cache. Refresh ~60s before expiry so we never send a
// stale token. Single-process cache is fine since Railway runs one
// instance per service; if we scale out, swap this for a DB-backed
// cache (similar to lib/qbo-tokens.js).
let _tokenCache = null; // { value, expiresAt: epochMs }
const REFRESH_LEEWAY_MS = 60 * 1000;

function basicHeader() {
  if (!SHIPTIME_CLIENT_ID || !SHIPTIME_API_SECRET) {
    throw new Error('ShipTime credentials missing: set SHIPTIME_CLIENT_ID and SHIPTIME_API_SECRET');
  }
  const creds = Buffer.from(`${SHIPTIME_CLIENT_ID}:${SHIPTIME_API_SECRET}`).toString('base64');
  return `Basic ${creds}`;
}

async function fetchOauthToken() {
  if (!SHIPTIME_CLIENT_ID || !SHIPTIME_API_SECRET) {
    throw new Error('ShipTime credentials missing: set SHIPTIME_CLIENT_ID and SHIPTIME_API_SECRET');
  }
  // TEMP DEBUG (remove once auth confirmed working). Logs lengths,
  // first/last 4 chars, and a sha256 hash so we can byte-compare against
  // PowerShell — never the full secret.
  const crypto = require('crypto');
  const _sha   = (s) => crypto.createHash('sha256').update(s, 'utf8').digest('hex');
  const _peek  = (s) => s ? `len=${s.length} ${s.slice(0,4)}…${s.slice(-4)} sha256=${_sha(s)}` : '<empty>';
  console.log('[shiptime DEBUG] CLIENT_ID  ', _peek(SHIPTIME_CLIENT_ID));
  console.log('[shiptime DEBUG] API_SECRET ', _peek(SHIPTIME_API_SECRET));
  console.log('[shiptime DEBUG] OAUTH_URL  ', SHIPTIME_OAUTH_URL);
  console.log('[shiptime DEBUG] AUTH_MODE  ', SHIPTIME_AUTH_MODE);
  // Standard OAuth2 client_credentials grant. We send credentials BOTH
  // ways (Basic auth header AND form body) because providers vary on
  // which they accept; sending both is harmless and maximally compatible.
  const body = new URLSearchParams({
    grant_type:    'client_credentials',
    client_id:     SHIPTIME_CLIENT_ID,
    client_secret: SHIPTIME_API_SECRET,
  });
  const _bodyStr = body.toString();
  console.log('[shiptime DEBUG] bodyStr    ', _bodyStr);
  // ShipTime's OAuth gateway rejects requests that include an
  // `Authorization: Basic` header alongside body credentials — returns 401
  // with empty body (nginx-level reject), even though curl with the same
  // pair works. Send credentials in the body only.
  const res = await fetch(SHIPTIME_OAUTH_URL, {
    method:  'POST',
    headers: {
      'Accept':        'application/json',
      'Content-Type':  'application/x-www-form-urlencoded',
    },
    body: _bodyStr,
  });
  console.log('[shiptime DEBUG] respStatus ', res.status);
  console.log('[shiptime DEBUG] respHeaders', JSON.stringify(Object.fromEntries(res.headers)));
  const text = await res.text();
  console.log('[shiptime DEBUG] respBody   ', JSON.stringify(text).slice(0, 200));
  let parsed;
  try { parsed = text ? JSON.parse(text) : null; } catch { parsed = text; }
  if (!res.ok) {
    const err = new Error(`ShipTime OAuth ${res.status}: ${typeof parsed === 'string' ? parsed : JSON.stringify(parsed)}`);
    err.status = res.status;
    err.body   = parsed;
    throw err;
  }
  const accessToken = parsed?.access_token;
  if (!accessToken) {
    throw new Error('ShipTime OAuth response missing access_token');
  }
  // Default to 1h if expires_in isn't returned (most providers send it).
  const expiresInSec = Number(parsed?.expires_in) || 3600;
  return {
    value:     accessToken,
    expiresAt: Date.now() + (expiresInSec * 1000),
  };
}

async function activeToken() {
  if (_tokenCache && _tokenCache.expiresAt - Date.now() > REFRESH_LEEWAY_MS) {
    return _tokenCache.value;
  }
  _tokenCache = await fetchOauthToken();
  return _tokenCache.value;
}

async function authHeader() {
  if (SHIPTIME_AUTH_MODE === 'basic') return basicHeader();
  const token = await activeToken();
  return `Bearer ${token}`;
}

async function request(method, path, body, { signal } = {}) {
  const url = `${SHIPTIME_BASE_URL}${path}`;
  const headers = {
    'Authorization': await authHeader(),
    'Accept':        'application/json',
  };
  const init = { method, headers, signal };
  if (body !== undefined) {
    headers['Content-Type'] = 'application/json';
    init.body = JSON.stringify(body);
  }
  const res = await fetch(url, init);
  const text = await res.text();
  let parsed;
  try { parsed = text ? JSON.parse(text) : null; } catch { parsed = text; }
  if (!res.ok) {
    const err = new Error(`ShipTime ${res.status}: ${typeof parsed === 'string' ? parsed : JSON.stringify(parsed)}`);
    err.status = res.status;
    err.body   = parsed;
    throw err;
  }
  return parsed;
}

// ─── conversions ─────────────────────────────────────────────────────────────

// ShipTime returns money as { amount: cents, currency: 'CAD'|'USD' }.
// Callers typically just want the dollars number.
function moneyToDollars(m) {
  if (!m || typeof m.amount !== 'number') return 0;
  return Math.round(m.amount) / 100;
}

// ─── address helpers ─────────────────────────────────────────────────────────

// ShipTime's AddressModel has hard length limits. Trim before sending so we
// don't get rejected on an otherwise-valid address.
function clampAddress(addr) {
  return {
    companyName:    (addr.companyName || '').slice(0, 40),
    streetAddress:  (addr.streetAddress || '').slice(0, 50),
    streetAddress2: addr.streetAddress2 ? addr.streetAddress2.slice(0, 35) : undefined,
    city:           (addr.city || '').slice(0, 40),
    countryCode:    addr.countryCode || 'CA',
    state:          addr.state,
    postalCode:     (addr.postalCode || '').slice(0, 10),
    attention:      (addr.attention || addr.companyName || '').slice(0, 40) || 'Recipient',
    email:          addr.email ? addr.email.slice(0, 40) : undefined,
    phone:          formatPhone(addr.phone),
    instructions:   addr.instructions ? addr.instructions.slice(0, 60) : undefined,
    residential:    Boolean(addr.residential),
    notify:         addr.notify !== false,
  };
}

// ShipTime requires Canadian/US phones in "NNN NNN NNNN" format and 10–15 chars.
function formatPhone(raw) {
  const digits = String(raw || '').replace(/\D+/g, '');
  if (digits.length === 10) return `${digits.slice(0,3)} ${digits.slice(3,6)} ${digits.slice(6)}`;
  if (digits.length === 11 && digits.startsWith('1')) {
    return `${digits.slice(1,4)} ${digits.slice(4,7)} ${digits.slice(7)}`;
  }
  // Fallback — let ShipTime reject if it's truly malformed; better to send
  // something than to silently lose the phone number.
  return digits || '000 000 0000';
}

// Our standard ship-from address (Holm Graphics). All online orders ship
// from here — confirmed in docs/dtf-online-store-plan.md.
function defaultShipFrom() {
  return clampAddress({
    companyName:   'Holm Graphics Inc.',
    streetAddress: '2-43 Eastridge Rd.',
    city:          'Walkerton',
    countryCode:   'CA',
    state:         'ON',
    postalCode:    'N0G 2V0',
    attention:     'Holm Graphics',
    email:         process.env.SHOP_FROM_EMAIL || 'orders@holmgraphics.ca',
    phone:         process.env.SHOP_PHONE || '519 881 0746',
    residential:   false,
  });
}

// ─── package profile (cart → ShipTime LineItem) ──────────────────────────────
//
// Maps a cart's total piece count + product weights to a single-package
// rate request. Per docs/dtf-online-store-plan.md "Package profile rules":
// poly mailers for small orders, boxes for larger. One package per request
// for v1 — multi-box orders can come later.
//
// orderItems: [{ quantity, weight_grams }]   (weight_grams nullable → use defaults by category)

const POUNDS_PER_GRAM = 1 / 453.59237;

function gramsToPounds(g) {
  return Number((g * POUNDS_PER_GRAM).toFixed(3));
}

// Default per-piece weights by garment category, used when supplier_product
// row has no weight_grams (NULL). Conservative averages.
function defaultWeightGrams(category) {
  switch (category) {
    case 'apparel':  return 250;   // mix of tees/hoodies
    case 'headwear': return 70;
    case 'aprons':   return 250;
    case 'bags':     return 100;
    default:         return 250;
  }
}

// Pick a package size based on item count. Returns { length, width, height }
// in INCHES (IMPERIAL) plus packaging weight in grams to add on top of
// the item weights. Sizes are guidance; real-world packing may differ.
function pickPackage(itemCount) {
  if (itemCount <= 3)  return { length: 13, width: 10, height: 1,  packagingGrams:  50 };
  if (itemCount <= 6)  return { length: 17, width: 14, height: 2,  packagingGrams:  80 };
  if (itemCount <= 12) return { length: 12, width: 10, height: 6,  packagingGrams: 200 };
  if (itemCount <= 24) return { length: 16, width: 12, height: 10, packagingGrams: 350 };
  if (itemCount <= 48) return { length: 20, width: 14, height: 12, packagingGrams: 600 };
  return { length: 24, width: 18, height: 14, packagingGrams: 1000 };
}

// Build a ShipTime LineItemModel from a cart summary.
// orderItems shape:
//   [{ quantity: number, weight_grams: number|null, garment_category: string }]
function buildLineItem(orderItems) {
  const totalCount = orderItems.reduce((n, it) => n + (Number(it.quantity) || 0), 0);
  if (totalCount === 0) throw new Error('Cannot quote shipping for empty cart');

  const itemsGrams = orderItems.reduce((g, it) => {
    const each = Number(it.weight_grams) || defaultWeightGrams(it.garment_category);
    return g + each * (Number(it.quantity) || 0);
  }, 0);

  const pkg = pickPackage(totalCount);
  const totalGrams = itemsGrams + pkg.packagingGrams;

  return {
    length:      pkg.length,
    width:       pkg.width,
    height:      pkg.height,
    weight:      Math.max(0.5, gramsToPounds(totalGrams)),  // ShipTime rejects 0
    description: `${totalCount} piece${totalCount === 1 ? '' : 's'} apparel`,
  };
}

// ─── public API ──────────────────────────────────────────────────────────────

// Build a RateRequest from cart + ship-to.
// shipTo: { name, addr1, addr2?, city, province, postal, country?, phone, email?, residential? }
function buildRateRequest({ orderItems, shipTo, shipDate }) {
  const lineItem = buildLineItem(orderItems);
  return {
    from: defaultShipFrom(),
    to:   clampAddress({
      companyName:    shipTo.company || shipTo.name || 'Recipient',
      attention:      shipTo.name || shipTo.company || 'Recipient',
      streetAddress:  shipTo.addr1,
      streetAddress2: shipTo.addr2 || undefined,
      city:           shipTo.city,
      state:          shipTo.province,
      postalCode:     shipTo.postal,
      countryCode:    shipTo.country || 'CA',
      email:          shipTo.email,
      phone:          shipTo.phone,
      residential:    shipTo.residential !== false,
    }),
    packageType:        'PACKAGE',
    lineItems:          [lineItem],
    unitOfMeasurement:  'IMPERIAL',
    shipDate:           shipDate || new Date().toISOString(),
  };
}

// Get rate quotes. Returns simplified quote objects (dollars, not cents).
async function quoteRates({ orderItems, shipTo, shipDate }) {
  const rateReq = buildRateRequest({ orderItems, shipTo, shipDate });
  const resp = await request('POST', '/rates/', rateReq);
  const rates = (resp?.availableRates || []).map((q) => ({
    quote_id:       q.quoteId,
    carrier_id:     q.carrierId,
    carrier_name:   q.carrierName,
    service_id:     q.serviceId,
    service_name:   q.serviceName,
    transit_days:   q.transitDays,
    transit_max:   q.transitDaysMax,
    base_charge:    moneyToDollars(q.baseCharge),
    total_before_tax: moneyToDollars(q.totalBeforeTaxes),
    tax_charge:     (q.taxes || []).reduce((s, t) => s + moneyToDollars(t.price), 0),
    total_charge:   moneyToDollars(q.totalCharge),
    surcharges:     (q.surcharges || []).map((s) => ({
      code: s.code, name: s.name, amount: moneyToDollars(s.price),
    })),
    cutoff_time:    q.cutoffTime,
  })).filter((q) => q.total_charge > 0);

  rates.sort((a, b) => a.total_charge - b.total_charge);
  return { rates, raw: resp, rate_request: rateReq };
}

// Book a shipment from a previously-quoted rate. Pass either a fresh
// quoteId (preferred — re-quote first to avoid 15-minute expiry) or a
// full {carrierId, serviceId} pair.
//
//   { carrierId, serviceId } + the same RateRequest used to quote
async function createShipment({ rateRequest, carrierId, serviceId, ref1, ref2 }) {
  const shipReq = {
    rateRequest,
    carrierId,
    serviceId,
    ref1: ref1 ? ref1.slice(0, 20) : undefined,
    ref2: ref2 ? ref2.slice(0, 20) : undefined,
  };
  const resp = await request('POST', '/shipments/', shipReq);
  return {
    ship_id:           resp.shipId,
    tracking_numbers:  resp.trackingNumbers || [],
    label_url:         resp.labelUrl,
    invoice_url:       resp.invoiceUrl,
    carrier_tracking_url: resp.carrierTrackingUrl,
    pickup_confirmation: resp.pickupConfirmation,
    messages:          resp.messages || [],
    raw:               resp,
  };
}

// Cancel a shipment (e.g. customer cancelled before label was used).
async function cancelShipment(shipId) {
  return request('DELETE', `/shipments/${encodeURIComponent(shipId)}`);
}

// Track a shipment by ShipTime shipId.
async function track(shipId) {
  return request('GET', `/track/${encodeURIComponent(shipId)}?includeTime=true`);
}

// Get the label PDF as a Buffer. Use this if you'd rather stream it
// through your own API than expose ShipTime's labelUrl directly.
async function getLabel(shipId) {
  const url = `${SHIPTIME_BASE_URL}/shipments/${encodeURIComponent(shipId)}/label`;
  const res = await fetch(url, { headers: { Authorization: authHeader() } });
  if (!res.ok) throw new Error(`ShipTime label ${res.status}`);
  return Buffer.from(await res.arrayBuffer());
}

module.exports = {
  quoteRates,
  createShipment,
  cancelShipment,
  track,
  getLabel,
  // exported for tests / adv. callers
  _internals: {
    buildRateRequest,
    buildLineItem,
    pickPackage,
    defaultWeightGrams,
    gramsToPounds,
    clampAddress,
    formatPhone,
    moneyToDollars,
  },
};
