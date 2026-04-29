// suppliers/ss_activewear/client.js
//
// Thin REST client for S&S Activewear Canada V2. Handles auth header
// construction + a single retry on transient 5xx, and surfaces the
// rate-limit headers so the ingester can pace itself if we ever hit the
// 60-req/min ceiling.
//
// The catalog is small enough that the ingester gets the whole thing in
// three unfiltered calls (/styles, /products, /inventory) — well under
// the limit — so this client doesn't bother with token-bucket pacing.
// If we ever add live inventory polling per-PDP, revisit.

'use strict';

const { loadConfig } = require('./config');

// Shared agent isn't needed at this volume; node:fetch handles keep-alive
// transparently and the ingester runs at most a few times per day.

function makeAuthHeader(account, apiKey) {
  return 'Basic ' + Buffer.from(`${account}:${apiKey}`).toString('base64');
}

// Single GET. Returns { status, headers, body } on 2xx, throws on 4xx/5xx
// (with one automatic retry on 502/503/504). The thrown Error carries
// .status, .body, .url so the caller can log structured failure data.
async function ssGet(pathAndQuery, { retryOn5xx = true } = {}) {
  const cfg = loadConfig();
  const url = `${cfg.baseUrl}${pathAndQuery}`;
  const headers = {
    Authorization: makeAuthHeader(cfg.credentials.account, cfg.credentials.apiKey),
    Accept:        'application/json',
  };

  let attempt = 0;
  while (true) {
    attempt++;
    let res;
    try {
      res = await fetch(url, { method: 'GET', headers });
    } catch (err) {
      // Network-level failure (DNS, TCP, TLS). Retry once if eligible.
      if (retryOn5xx && attempt === 1) continue;
      const e = new Error(`S&S network error: ${err.message}`);
      e.cause = err;
      e.url   = url;
      throw e;
    }
    const rateRemaining = res.headers.get('x-rate-limit-remaining');
    const rateReset     = res.headers.get('x-rate-limit-reset');
    const text = await res.text();
    let body;
    try { body = JSON.parse(text); } catch { body = text; }

    if (res.ok) {
      return { status: res.status, body, rateRemaining, rateReset, url };
    }
    // 5xx: one retry then bail. 4xx: bail immediately (won't fix itself).
    const isTransient = res.status >= 502 && res.status <= 504;
    if (retryOn5xx && isTransient && attempt === 1) {
      await new Promise((r) => setTimeout(r, 800));
      continue;
    }
    const e = new Error(`S&S ${res.status} ${res.statusText} for ${pathAndQuery}`);
    e.status = res.status;
    e.body   = body;
    e.url    = url;
    e.rateRemaining = rateRemaining;
    throw e;
  }
}

// Three concrete catalog endpoints — kept here so the ingester reads
// declaratively and we have one place to update if S&S ever changes V2.
//
// listStyles({ styleID? })       → array of style records
// listProducts({ styleID? })     → array of variant records (has prices, images, hex)
// listInventory({ styleID? })    → array of variant inventory (has warehouses[], qty)
//
// styleID is optional on all three — omit for a full-catalog pull, pass
// to scope to one style for the smoke test.

async function listStyles({ styleID } = {}) {
  const q = styleID ? `?styleID=${encodeURIComponent(styleID)}` : '';
  const { body, rateRemaining } = await ssGet(`/V2/styles${q}`);
  if (!Array.isArray(body)) throw new Error('listStyles: expected array');
  return { items: body, rateRemaining };
}

async function listProducts({ styleID } = {}) {
  const q = styleID ? `?styleID=${encodeURIComponent(styleID)}` : '';
  const { body, rateRemaining } = await ssGet(`/V2/products${q}`);
  if (!Array.isArray(body)) throw new Error('listProducts: expected array');
  return { items: body, rateRemaining };
}

async function listInventory({ styleID } = {}) {
  const q = styleID ? `?styleID=${encodeURIComponent(styleID)}` : '';
  const { body, rateRemaining } = await ssGet(`/V2/inventory${q}`);
  if (!Array.isArray(body)) throw new Error('listInventory: expected array');
  return { items: body, rateRemaining };
}

module.exports = { ssGet, listStyles, listProducts, listInventory };
