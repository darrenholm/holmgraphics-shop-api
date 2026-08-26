// lib/call-hub.js
// In-process Server-Sent Events hub for the inbound-call screen pop.
//
// WHY SSE AND NOT SUPABASE REALTIME: the Supabase Data API is disabled and the
// anon/service_role keys are pending rotation. Realtime would mean re-opening
// a browser-facing Supabase surface and pinning it to a key that's about to
// change. SSE keeps this API as the only trusted middle and adds no public
// surface.
//
// ⚠ SINGLE-INSTANCE ONLY. Subscribers live in a Set in this process's memory.
// The moment the API runs on more than one Railway replica, a phone event that
// lands on replica A will not reach a browser held open by replica B — half
// the shop stops getting pops, silently. The fix at that point is Postgres
// LISTEN/NOTIFY: publish() becomes `NOTIFY call_events, '<json>'` and each
// replica holds one dedicated pg client on LISTEN, feeding its local Set.
// Nothing above this file changes. Do not scale replicas before doing that.

'use strict';

// Railway's edge closes connections that go quiet. 25s beats every idle
// timeout we've seen and is well inside the 30s the browser's own
// reconnect logic would otherwise start guessing at.
const HEARTBEAT_MS = 25_000;

const subscribers = new Set(); // of { res, id }

let nextId = 1;
let heartbeat = null;

function startHeartbeat() {
  if (heartbeat) return;
  heartbeat = setInterval(() => {
    for (const sub of subscribers) {
      // A bare SSE comment. Keeps the socket warm without the client
      // seeing a message event.
      try { sub.res.write(': ping\n\n'); } catch { drop(sub); }
    }
  }, HEARTBEAT_MS);
  // Don't hold the process open for the heartbeat alone.
  if (typeof heartbeat.unref === 'function') heartbeat.unref();
}

function stopHeartbeatIfIdle() {
  if (subscribers.size === 0 && heartbeat) {
    clearInterval(heartbeat);
    heartbeat = null;
  }
}

function drop(sub) {
  subscribers.delete(sub);
  try { sub.res.end(); } catch {}
  stopHeartbeatIfIdle();
}

// Attach an Express response as an SSE stream. Returns a detach function.
function subscribe(req, res) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    // Belt and braces against any proxy that buffers by default.
    'X-Accel-Buffering': 'no',
  });
  // Flush the headers immediately — the browser's fetch() reader stays
  // pending until the first byte arrives.
  res.write(': connected\n\n');

  const sub = { res, id: nextId++ };
  subscribers.add(sub);
  startHeartbeat();

  const detach = () => drop(sub);
  req.on('close', detach);
  req.on('error', detach);
  return detach;
}

// Broadcast one payload to every connected browser.
//
// `id` lets the client de-duplicate if it ever reconnects mid-burst; we do NOT
// implement Last-Event-ID replay, because a call that rang while nobody was
// looking is not worth popping after the fact.
function publish(payload) {
  const frame = `event: call\ndata: ${JSON.stringify(payload)}\n\n`;
  for (const sub of subscribers) {
    try { sub.res.write(frame); } catch { drop(sub); }
  }
  return subscribers.size;
}

function subscriberCount() {
  return subscribers.size;
}

module.exports = { subscribe, publish, subscriberCount, HEARTBEAT_MS };
