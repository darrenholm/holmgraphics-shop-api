// suppliers/sinalite/client.js
//
// SinaLite (wholesale commercial print) REST client. Pricing + shipping
// estimates only for now — ordering comes later.
//
// Docs: https://api.sinaliteuppy.com/  (the sandbox host serves the docs too)
//
// Env vars (set in Railway):
//   SINALITE_CLIENT_ID      from the SinaLite portal → Account tab
//   SINALITE_CLIENT_SECRET  "
//   SINALITE_ENV            'sandbox' (default) or 'live'
//
// Store code 6 = SinaLite Canada (CAD). 9 would be the US store.

'use strict';

const HOSTS = {
  sandbox: 'https://api.sinaliteuppy.com',
  live:    'https://liveapi.sinalite.com',
};
const AUDIENCE = 'https://apiconnect.sinalite.com';
const STORE_CANADA = 6;

// Product list barely changes; option lists change rarely. Cache both in
// memory so opening the picker twice doesn't hammer SinaLite.
const PRODUCTS_TTL_MS = 6 * 60 * 60 * 1000;
const OPTIONS_TTL_MS  = 60 * 60 * 1000;

function loadConfig() {
  const env = (process.env.SINALITE_ENV || 'sandbox').toLowerCase() === 'live' ? 'live' : 'sandbox';
  return {
    env,
    host: HOSTS[env],
    clientId: process.env.SINALITE_CLIENT_ID || '',
    clientSecret: process.env.SINALITE_CLIENT_SECRET || '',
    storeCode: STORE_CANADA,
  };
}

function isConfigured(cfg = loadConfig()) {
  return Boolean(cfg.clientId && cfg.clientSecret);
}

let tokenCache = { token: null, expiresAt: 0, env: null };
let productsCache = { at: 0, env: null, rows: null };
const optionsCache = new Map(); // `${env}:${id}` → { at, data }

// Read `exp` out of the JWT so we refresh just before it lapses. If the
// token isn't a readable JWT, fall back to 50 minutes.
function tokenExpiry(token) {
  try {
    const payload = JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString('utf8'));
    if (payload.exp) return payload.exp * 1000 - 60 * 1000;
  } catch { /* not a JWT we can read */ }
  return Date.now() + 50 * 60 * 1000;
}

async function getToken(cfg) {
  if (tokenCache.token && tokenCache.env === cfg.env && Date.now() < tokenCache.expiresAt) {
    return tokenCache.token;
  }
  const res = await fetch(`${cfg.host}/auth/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      client_id: cfg.clientId,
      client_secret: cfg.clientSecret,
      audience: AUDIENCE,
      grant_type: 'client_credentials',
    }),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok || !body.access_token) {
    throw new Error(`SinaLite login failed (${res.status}) — check SINALITE_CLIENT_ID / SECRET`);
  }
  tokenCache = { token: body.access_token, expiresAt: tokenExpiry(body.access_token), env: cfg.env };
  return body.access_token;
}

// One authenticated call. Retries once on 401 in case the cached token
// was revoked early.
async function call(method, path, body, cfg = loadConfig(), retried = false) {
  if (!isConfigured(cfg)) {
    const e = new Error('SinaLite is not set up yet — add SINALITE_CLIENT_ID and SINALITE_CLIENT_SECRET in Railway');
    e.status = 503;
    throw e;
  }
  const token = await getToken(cfg);
  const res = await fetch(`${cfg.host}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      Accept: 'application/json',
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (res.status === 401 && !retried) {
    tokenCache = { token: null, expiresAt: 0, env: null };
    return call(method, path, body, cfg, true);
  }
  const text = await res.text();
  let data;
  try { data = text ? JSON.parse(text) : null; } catch { data = text; }
  if (!res.ok) {
    const msg = (data && (data.message || data.error)) || (typeof data === 'string' ? data.slice(0, 200) : '');
    const e = new Error(`SinaLite ${method} ${path} failed (${res.status})${msg ? `: ${msg}` : ''}`);
    e.status = 502;
    throw e;
  }
  return data;
}

// ─── Pure helpers (tested in sinalite.test.js) ───────────────────────────

// Sort option names naturally so qty reads 5, 10, 25, 100, 1000 rather
// than 10, 100, 1000, 25, 5.
function naturalCompare(a, b) {
  return String(a).localeCompare(String(b), undefined, { numeric: true, sensitivity: 'base' });
}

// SinaLite returns options as one flat list [{id, group, name}]. Group
// them for the picker, keeping first-seen group order but putting qty
// first and Turnaround last since that's how staff think about it.
function groupOptions(flat) {
  const groups = new Map();
  for (const o of Array.isArray(flat) ? flat : []) {
    if (!o || o.id == null || !o.group) continue;
    if (!groups.has(o.group)) groups.set(o.group, []);
    groups.get(o.group).push({ id: Number(o.id), name: String(o.name ?? '') });
  }
  const rank = (g) => (/^qty$/i.test(g) ? 0 : /^turnaround$/i.test(g) ? 2 : 1);
  return [...groups.entries()]
    .map(([group, options]) => ({ group, options: options.sort((a, b) => naturalCompare(a.name, b.name)) }))
    .sort((a, b) => rank(a.group) - rank(b.group));
}

// /product/{id}/{store} returns [options, priceHashes, metadata].
function parseProductDetail(raw) {
  const arr = Array.isArray(raw) ? raw : [];
  const metadata = (Array.isArray(arr[2]) ? arr[2] : [])
    .map((m) => m && m.metadata)
    .filter(Boolean);
  return { groups: groupOptions(arr[0]), metadata };
}

// Shipping estimate body is { statusCode, body: [[carrier, method, price, days], ...] }.
function parseShipping(raw) {
  const rows = raw && Array.isArray(raw.body) ? raw.body : Array.isArray(raw) ? raw : [];
  return rows
    .filter((r) => Array.isArray(r) && r.length >= 3)
    .map(([carrier, method, price, days]) => ({
      carrier: String(carrier),
      method: String(method),
      price: Number(price) || 0,
      days: days == null ? null : Number(days),
    }))
    .sort((a, b) => a.price - b.price);
}

// Order/shipping calls want options as { groupName: "optionId" }.
function optionsByGroup(groups, optionIds) {
  const want = new Set((optionIds || []).map(Number));
  const out = {};
  for (const g of groups) {
    const hit = g.options.find((o) => want.has(o.id));
    if (hit) out[g.group] = String(hit.id);
  }
  return out;
}

// ─── API calls ───────────────────────────────────────────────────────────

async function listProducts() {
  const cfg = loadConfig();
  if (productsCache.rows && productsCache.env === cfg.env && Date.now() - productsCache.at < PRODUCTS_TTL_MS) {
    return productsCache.rows;
  }
  const raw = await call('GET', '/product', null, cfg);
  const rows = (Array.isArray(raw) ? raw : [])
    .map((p) => ({
      id: Number(p.id),
      sku: p.sku || '',
      name: String(p.name || '').trim(),
      category: String(p.category || 'Other').trim(),
      enabled: Number(p.enabled) === 1,
    }))
    .sort((a, b) => naturalCompare(a.category, b.category) || naturalCompare(a.name, b.name));
  productsCache = { at: Date.now(), env: cfg.env, rows };
  return rows;
}

async function getProductOptions(productId) {
  const cfg = loadConfig();
  const key = `${cfg.env}:${productId}`;
  const hit = optionsCache.get(key);
  if (hit && Date.now() - hit.at < OPTIONS_TTL_MS) return hit.data;
  const raw = await call('GET', `/product/${productId}/${cfg.storeCode}`, null, cfg);
  const data = parseProductDetail(raw);
  optionsCache.set(key, { at: Date.now(), data });
  return data;
}

async function getPrice(productId, optionIds) {
  const cfg = loadConfig();
  const raw = await call('POST', `/price/${productId}/${cfg.storeCode}`,
    { productOptions: optionIds.map(Number) }, cfg);
  return {
    price: Number(raw && raw.price) || 0,
    packageInfo: (raw && raw.packageInfo) || {},
    productOptions: (raw && raw.productOptions) || {},
  };
}

async function getShippingEstimate(productId, optionIds, dest) {
  const { groups } = await getProductOptions(productId);
  const raw = await call('POST', '/order/shippingEstimate', {
    items: [{ productId: Number(productId), options: optionsByGroup(groups, optionIds) }],
    shippingInfo: {
      ShipState: dest.state,
      ShipZip: dest.zip,
      ShipCountry: dest.country || 'CA',
    },
  });
  return parseShipping(raw);
}

module.exports = {
  loadConfig,
  isConfigured,
  listProducts,
  getProductOptions,
  getPrice,
  getShippingEstimate,
  // exported for tests
  groupOptions,
  parseProductDetail,
  parseShipping,
  optionsByGroup,
};
