// phone-bridge/server.js
// Plain-HTTP relay between the Grandstream desk phones and the shop API.
//
// WHY THIS EXISTS: the GXP16xx/21xx firmware will not fire an Action URL over
// https, and will not follow the 301 that api.holmgraphics.ca returns on plain
// http. Proven the hard way — a 67-character https URL fired nothing, a
// 52-character https URL fired nothing, and Step 0's 49-character plain-http
// LAN URL fired instantly. So the phones talk http to this box, and this box
// talks https to Railway.
//
// It also keeps the ingest token OFF the handsets. A phone's config is
// readable by anyone who can reach its web GUI, and there are six of them.
// The token lives here instead, which has the happy side effect of making the
// phone URL 49 characters — exactly the length Step 0 proved.
//
//     phone  →  http://10.10.1.24:8085/t?r=$remote&e=$active_user
//     here   →  https://api.holmgraphics.ca/t/<token>?r=…&e=…
//
// The phone gets its 200 immediately; the forward happens after. A handset
// waiting on a WAN round-trip is a handset that rings late.
//
// Runs on DesignCentre4 (10.10.1.24) as the scheduled task "Holm Phone
// Bridge" — SYSTEM / AtStartup, same shape as the files-bridge next door.

'use strict';

const fs    = require('fs');
const path  = require('path');
const http  = require('http');
const https = require('https');
const { URL } = require('url');

// Minimal .env reader rather than the dotenv package, so the install
// directory is just server.js + .env with no node_modules to keep in step.
(function loadEnv() {
  const file = path.join(__dirname, '.env');
  if (!fs.existsSync(file)) return;
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const m = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (!m) continue;                       // blank line or # comment
    const key = m[1];
    if (process.env[key] !== undefined) continue;   // real env wins
    process.env[key] = m[2].trim().replace(/^["']|["']$/g, '');
  }
})();

const PORT     = parseInt(process.env.PORT || '8085', 10);
const API_BASE = (process.env.API_BASE || 'https://api.holmgraphics.ca').replace(/\/$/, '');
const TOKEN    = (process.env.TELEPHONY_INGEST_TOKEN || '').trim();

// Optional allowlist of handset IPs. Empty means "any private address" —
// there is no shared secret on the phone side (adding one would put URL
// length back in play), so the network IS the boundary. Listing the phones
// explicitly is better; do it once the fleet is configured.
const ALLOWED = (process.env.ALLOWED_IPS || '')
  .split(',').map((s) => s.trim()).filter(Boolean);

// Event paths, mirroring routes/telephony.js. One letter each so the phone
// URL stays short.
const PATHS = new Set(['t', 'ta', 'te', 'to']);

function log(...args) {
  console.log(new Date().toISOString(), ...args);
}

// Strip the IPv4-mapped IPv6 prefix Node hands back on dual-stack sockets.
function clientIp(req) {
  const raw = req.socket.remoteAddress || '';
  return raw.replace(/^::ffff:/, '');
}

function isPrivate(ip) {
  if (ip === '127.0.0.1' || ip === '::1') return true;
  if (/^10\./.test(ip)) return true;
  if (/^192\.168\./.test(ip)) return true;
  if (/^172\.(1[6-9]|2\d|3[01])\./.test(ip)) return true;
  return false;
}

function allowed(ip) {
  if (ALLOWED.length) return ALLOWED.includes(ip);
  return isPrivate(ip);
}

// Fire the upstream request and forget it. Never throws, never blocks the
// response to the phone. A failure here loses one pop — the alternative,
// queueing and retrying, would replay a stale "incoming call" onto someone's
// screen minutes after the phone stopped ringing, which is worse.
function forward(eventPath, search) {
  const target = new URL(`${API_BASE}/${eventPath}/${encodeURIComponent(TOKEN)}${search}`);
  const req = https.request(
    target,
    { method: 'GET', timeout: 8000 },
    (res) => {
      res.resume(); // drain so the socket can be reused
      if (res.statusCode !== 200) {
        log(`upstream ${res.statusCode} for /${eventPath}${search}`);
      }
    }
  );
  req.on('timeout', () => { log(`upstream timeout for /${eventPath}`); req.destroy(); });
  req.on('error', (e) => log(`upstream error for /${eventPath}: ${e.message}`));
  req.end();
}

const server = http.createServer((req, res) => {
  const ip = clientIp(req);
  // req.url is a path + query, never absolute, so a dummy origin is fine.
  const parsed = new URL(req.url, 'http://bridge.local');
  const seg = parsed.pathname.replace(/^\/+|\/+$/g, '');

  if (seg === 'health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({
      ok: true,
      service: 'phone-bridge',
      port: PORT,
      apiBase: API_BASE,
      tokenConfigured: Boolean(TOKEN),
      allowlist: ALLOWED.length ? ALLOWED : '(any private address)',
    }));
  }

  if (!allowed(ip)) {
    log(`refused ${ip} → ${req.url}`);
    res.writeHead(403, { 'Content-Type': 'text/plain' });
    return res.end('forbidden');
  }

  if (!PATHS.has(seg)) {
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    return res.end('not found');
  }

  // Answer the handset first, always.
  res.writeHead(200, { 'Content-Type': 'text/plain' });
  res.end('ok');

  log(`${ip} → /${seg}${parsed.search}`);

  if (!TOKEN) {
    log('TELEPHONY_INGEST_TOKEN is not set — dropping (nothing to authenticate with)');
    return;
  }
  forward(seg, parsed.search);
});

server.listen(PORT, '0.0.0.0', () => {
  log(`phone-bridge listening on 0.0.0.0:${PORT} → ${API_BASE}`);
  log(`token ${TOKEN ? 'configured' : 'MISSING — forwards will be dropped'}`);
  log(`allowlist: ${ALLOWED.length ? ALLOWED.join(', ') : '(any private address)'}`);
});

server.on('error', (e) => {
  log(`FATAL: ${e.message}`);
  process.exit(1);
});
