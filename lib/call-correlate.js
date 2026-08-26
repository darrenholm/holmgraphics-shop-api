// lib/call-correlate.js
// The bookkeeping that turns a stream of dumb Action URL hits into one screen
// pop per actual phone call.
//
// The hardware gives us nothing to work with: $call_id and $callid are not
// supported on this firmware (they arrive as literal text), so there is no
// device-supplied key joining ringing → answered → ended. Everything here is
// server-side inference from (remote number, wall clock).
//
// Three separate jobs, easy to conflate:
//
//  1. RETRY DEDUPE — the same handset re-fires an identical event because the
//     first HTTP request didn't get a fast enough 200. Identical
//     (event, remote, ext) inside RETRY_WINDOW_MS is dropped outright: no row,
//     no pop.
//
//  2. RING-GROUP COLLAPSE — one inbound call rings six handsets and each fires
//     its own Incoming Call event. All six are real and all six are logged
//     (the set of extensions IS the list of desks that rang), but only the
//     FIRST publishes a pop. The rest are folded into the same pop key.
//
//  3. LIFECYCLE CORRELATION — an 'answered' or 'ended' event carries no hint
//     of which ring it belongs to, so it is matched to the most recent open
//     pop for the same remote number within CORRELATION_WINDOW_MS.
//
// State is in-process. Same single-instance caveat as lib/call-hub.js: on a
// second replica, the ringing and the answered event can land on different
// processes and the correlation quietly stops working.

'use strict';

const RETRY_WINDOW_MS       = 10_000;   // spec: identical event inside 10s is a retry
const RING_GROUP_WINDOW_MS  = 20_000;   // a ring group finishes ringing well inside this
const CORRELATION_WINDOW_MS = 120_000;  // spec: join answered/ended on number + 2 min
const SWEEP_EVERY_MS        = 60_000;

class CallCorrelator {
  constructor({ now = () => Date.now() } = {}) {
    this._now = now;
    this._recent = new Map();  // retry key            → last-seen ms
    this._open   = new Map();  // remote identity      → { key, firstSeenMs, exts:Set }
    this._seq    = 0;
  }

  // Stable identity for a caller. Falls back to the raw string when the
  // number didn't parse, so a blocked/garbled caller still correlates with
  // itself for the length of the call.
  static identity({ remoteE164, remoteRaw }) {
    return remoteE164 || `raw:${String(remoteRaw ?? '').trim()}`;
  }

  // True when this exact event is a duplicate of one seen inside the retry
  // window. Records the sighting either way.
  isRetry({ event, remoteE164, remoteRaw, localExt }) {
    const now = this._now();
    const key = `${event}|${CallCorrelator.identity({ remoteE164, remoteRaw })}|${localExt || ''}`;
    const last = this._recent.get(key);
    this._recent.set(key, now);
    this._sweep(now);
    return last !== undefined && now - last < RETRY_WINDOW_MS;
  }

  // Register a 'ringing' event.
  //   { key, isNewPop, ringingExts }
  // isNewPop=false means another handset already popped this call — log the
  // row, skip the broadcast.
  ring({ remoteE164, remoteRaw, localExt }) {
    const now = this._now();
    const id = CallCorrelator.identity({ remoteE164, remoteRaw });
    const open = this._open.get(id);

    if (open && now - open.lastSeenMs < RING_GROUP_WINDOW_MS) {
      open.lastSeenMs = now;
      if (localExt) open.exts.add(String(localExt));
      return { key: open.key, isNewPop: false, ringingExts: [...open.exts] };
    }

    const key = `c${now.toString(36)}-${++this._seq}`;
    const entry = {
      key,
      firstSeenMs: now,
      lastSeenMs: now,
      exts: new Set(localExt ? [String(localExt)] : []),
    };
    this._open.set(id, entry);
    return { key, isNewPop: true, ringingExts: [...entry.exts] };
  }

  // Find the pop an 'answered' / 'ended' event belongs to. Returns the key, or
  // null when nothing rang for this number recently (e.g. the API restarted
  // mid-call, or the ringing event never arrived).
  correlate({ remoteE164, remoteRaw }) {
    const now = this._now();
    const id = CallCorrelator.identity({ remoteE164, remoteRaw });
    const open = this._open.get(id);
    if (!open) return null;
    if (now - open.firstSeenMs > CORRELATION_WINDOW_MS) return null;
    open.lastSeenMs = now;
    return open.key;
  }

  // Called on 'ended' so a second call from the same number opens a new pop
  // instead of folding into the finished one.
  close({ remoteE164, remoteRaw }) {
    this._open.delete(CallCorrelator.identity({ remoteE164, remoteRaw }));
  }

  // Bounded memory: nothing here outlives the correlation window by much.
  // Cheap enough to run inline — the maps hold one entry per active call.
  _sweep(now) {
    if (now - (this._lastSweep || 0) < SWEEP_EVERY_MS) return;
    this._lastSweep = now;
    for (const [k, t] of this._recent) {
      if (now - t > RETRY_WINDOW_MS * 2) this._recent.delete(k);
    }
    for (const [k, v] of this._open) {
      if (now - v.firstSeenMs > CORRELATION_WINDOW_MS) this._open.delete(k);
    }
  }
}

module.exports = {
  CallCorrelator,
  RETRY_WINDOW_MS,
  RING_GROUP_WINDOW_MS,
  CORRELATION_WINDOW_MS,
};
