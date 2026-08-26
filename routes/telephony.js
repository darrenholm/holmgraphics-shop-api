// routes/telephony.js
// Inbound call screen pop — Phase 1.
//
// Two surfaces:
//   • the ingest endpoints the Grandstream handsets hit when they ring
//   • the SSE stream the shop app holds open to receive pops
//
// ─── WHY THE PATHS ARE THIS SHORT ────────────────────────────────────────────
// The GXP16xx/21xx Action URL field silently stops firing above roughly 60-70
// characters. The phone ACCEPTS a longer URL, stores it, shows it back to you
// in the GUI — and then never sends a request. There is no error anywhere.
//
// So the spec's `POST /api/telephony/grandstream/:token` is not buildable:
// the path alone is over budget before the host or the token. Budget for the
// shape we actually use:
//
//     https://api.holmgraphics.ca/t/<token>?r=$remote&e=$active_user
//     └────────── 27 ─────────┘└3┘└  T  ┘└────────── 25 ──────────┘
//
// = 55 + len(token). A 12-character token lands at 67 — inside the ceiling
// with a little headroom. See TELEPHONY_INGEST_TOKEN in .env.example, and
// GET /api/telephony/config, which prints the exact strings to paste into each
// phone along with their character counts.
//
// One path per event, because a `&v=ringing`-style query parameter costs more
// characters than a second letter in the path:
//     /t/…   Incoming Call   → ringing, inbound
//     /ta/…  Answered Call   → answered
//     /te/…  Call Terminated → ended
//     /to/…  Outgoing Call   → ringing, outbound
//
// Both GET and POST are accepted; the firmware's Action URL is a GET, but
// which verb a given release uses is not worth discovering the hard way.

'use strict';

const crypto  = require('crypto');
const express = require('express');

const { query } = require('../db/connection');
const { requireStaff, requireAdmin } = require('../middleware/auth');
const { toE164, isAnonymous, isInternalExtension } = require('../lib/phone');
const { buildPayload, employeeNameForExtension } = require('../lib/screen-pop');
const { CallCorrelator } = require('../lib/call-correlate');
const hub = require('../lib/call-hub');

const router = express.Router();
const correlator = new CallCorrelator();

// ─── Token ───────────────────────────────────────────────────────────────────
// Compared over SHA-256 digests so timingSafeEqual always gets equal-length
// buffers and the comparison leaks nothing about the token's length.
const INGEST_TOKEN = (process.env.TELEPHONY_INGEST_TOKEN || '').trim();
const INGEST_DIGEST = INGEST_TOKEN
  ? crypto.createHash('sha256').update(INGEST_TOKEN).digest()
  : null;

function tokenOk(candidate) {
  if (!INGEST_DIGEST) return false; // unset token means the endpoint is closed
  const given = crypto.createHash('sha256').update(String(candidate || '')).digest();
  return crypto.timingSafeEqual(given, INGEST_DIGEST);
}

// ─── Rate limit ──────────────────────────────────────────────────────────────
// Six handsets, a few events each per call. 120/minute is far above any real
// ring-group burst and far below anything that could hurt.
const RATE_LIMIT_MAX    = 120;
const RATE_LIMIT_WINDOW = 60_000;
let rateWindowStart = Date.now();
let rateCount = 0;

function rateLimited() {
  const now = Date.now();
  if (now - rateWindowStart > RATE_LIMIT_WINDOW) {
    rateWindowStart = now;
    rateCount = 0;
  }
  return ++rateCount > RATE_LIMIT_MAX;
}

// ─── Ingest ──────────────────────────────────────────────────────────────────

// Respond 200 and get off the phone's back BEFORE doing any database work.
// A slow response here delays the handset's own ring handling.
function ack(res) {
  res.status(200).type('text/plain').send('ok');
}

async function handleEvent({ event, direction, remoteRaw, localExt }) {
  const anonymous  = isAnonymous(remoteRaw);
  const internal   = !anonymous && isInternalExtension(remoteRaw);
  const remoteE164 = anonymous || internal ? null : toE164(remoteRaw);

  // 1. Retry dedupe — an identical event inside 10s is the phone re-sending.
  if (correlator.isRetry({ event, remoteE164, remoteRaw, localExt })) return;

  // 2. Correlate to a pop.
  let key, isNewPop;
  if (event === 'ringing') {
    ({ key, isNewPop } = correlator.ring({ remoteE164, remoteRaw, localExt }));
  } else {
    key = correlator.correlate({ remoteE164, remoteRaw });
    isNewPop = false;
  }

  // 3. Who picked up. Only meaningful on 'answered' — the Incoming Call event
  //    fires on every handset in the group and says nothing about who took it.
  const handledBy = event === 'answered'
    ? await employeeNameForExtension(localExt)
    : null;

  // 4. Build the payload first: the client id it resolves is what the log row
  //    records, so the two can't disagree.
  const matchKind = anonymous ? 'anonymous' : internal ? 'internal' : null;
  let payload = null;
  try {
    payload = await buildPayload({
      event, key, remoteRaw, remoteE164, localExt, direction, handledBy, matchKind,
    });
  } catch (e) {
    console.error('[telephony] payload build failed:', e.message);
  }

  // 5. Log every event, matched or not. A payload failure must not cost us
  //    the log row — that's the one thing this endpoint owes unconditionally.
  const clientId = payload && payload.match === 'one' ? payload.clients[0].id : null;
  try {
    await query(
      `INSERT INTO calls (event, direction, remote_raw, remote_e164, local_ext,
                          client_id, started_at, ended_at, handled_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [
        event,
        direction,
        remoteRaw ?? null,
        remoteE164,
        localExt || null,
        clientId,
        event === 'ringing' ? new Date() : null,
        event === 'ended'   ? new Date() : null,
        handledBy,
      ]
    );
  } catch (e) {
    console.error('[telephony] call log insert failed:', e.message);
  }

  // 6. The call is over: forget it, so a callback from the same number a
  //    moment later opens a fresh pop instead of folding into the finished
  //    one. Done before the broadcast guards below so a payload failure
  //    can't leave a stale entry blocking the next call.
  if (event === 'ended') correlator.close({ remoteE164, remoteRaw });

  // 7. Broadcast. A ring-group member that didn't open the pop is logged but
  //    stays silent — one call, one pop.
  if (!payload) return;
  if (event === 'ringing' && !isNewPop) return;
  // An answered/ended event we couldn't tie to a ring has no card to update;
  // dropping it beats popping a bare "call ended" toast out of nowhere.
  if (event !== 'ringing' && !key) return;

  hub.publish(payload);
}

function ingest(event, direction) {
  return (req, res) => {
    if (!tokenOk(req.params.token)) {
      // Nothing about the attempt is logged: the token is in the path, and
      // req.path would put it straight into the log line we're trying to
      // keep it out of.
      return res.status(401).type('text/plain').send('unauthorized');
    }
    if (rateLimited()) return res.status(429).type('text/plain').send('slow down');

    const src = req.method === 'POST' && req.body && Object.keys(req.body).length
      ? { ...req.query, ...req.body }
      : req.query;

    ack(res);

    // Fire-and-forget: the phone is already unblocked.
    handleEvent({
      event,
      direction,
      remoteRaw: src.r,
      localExt:  src.e,
    }).catch((e) => console.error('[telephony] handleEvent:', e.message));
  };
}

router.all('/t/:token',  ingest('ringing',  'inbound'));
router.all('/ta/:token', ingest('answered', 'inbound'));
router.all('/te/:token', ingest('ended',    'inbound'));
router.all('/to/:token', ingest('ringing',  'outbound'));

// ─── Browser stream ──────────────────────────────────────────────────────────
// EventSource cannot send an Authorization header, so the shop client consumes
// this with fetch() + a stream reader instead (see src/lib/stores/call-pop.js).
// That keeps the JWT in a header and out of the URL — a token in a query
// string ends up in Railway's request logs and in the browser's history.
router.get('/api/telephony/stream', requireStaff, (req, res) => {
  req.socket.setTimeout(0);
  req.socket.setNoDelay(true);
  req.socket.setKeepAlive(true);
  hub.subscribe(req, res);
});

// ─── Rollout helper ──────────────────────────────────────────────────────────
// Prints the exact Action URL to paste into each phone's GUI, with the
// character count next to it, because the failure mode for an over-long URL
// is silence. Admin-only: the strings contain the ingest token.
router.get('/api/telephony/config', requireAdmin, (req, res) => {
  const base = (process.env.TELEPHONY_PUBLIC_BASE || 'https://api.holmgraphics.ca')
    .replace(/\/$/, '');
  const q = '?r=$remote&e=$active_user';
  const build = (p) => {
    const url = `${base}/${p}/${INGEST_TOKEN}${q}`;
    return { url, length: url.length, overBudget: url.length > 70 };
  };
  res.json({
    configured: Boolean(INGEST_TOKEN),
    subscribers: hub.subscriberCount(),
    // Settings → Outbound Notification → Action URL, one field each.
    actionUrls: {
      'Incoming Call':   build('t'),
      'Answered Call':   build('ta'),
      'Call Terminated': build('te'),
      'Outgoing Call':   build('to'),
    },
    note: 'The GXP handsets silently ignore Action URLs above roughly 70 characters. '
        + 'Shorten TELEPHONY_INGEST_TOKEN if any entry reports overBudget.',
  });
});

// ─── Recent calls ────────────────────────────────────────────────────────────
// Small read-only log view. Mostly for verifying a rollout ("did that call
// land?") without opening a psql session.
router.get('/api/telephony/recent', requireStaff, async (req, res) => {
  let limit = parseInt(req.query.limit, 10);
  if (!Number.isFinite(limit) || limit <= 0) limit = 50;
  if (limit > 200) limit = 200;
  try {
    const rows = await query(
      `SELECT c.id, c.event, c.direction, c.remote_raw, c.remote_e164,
              c.local_ext, c.handled_by, c.client_id, c.created_at,
              COALESCE(cl.company, CONCAT_WS(' ', cl.fname, cl.lname)) AS client_name
         FROM calls c
         LEFT JOIN clients cl ON cl.id = c.client_id
        ORDER BY c.created_at DESC
        LIMIT $1`,
      [limit]
    );
    res.json(rows);
  } catch (e) {
    console.error('GET /api/telephony/recent:', e);
    res.status(500).json({ message: 'Failed to load calls', detail: e.message });
  }
});

module.exports = router;
