// lib/screen-pop.js
// Turns a normalized caller number into the card the shop sees while the
// phone is still ringing.
//
// Everything the pop renders is assembled HERE, server-side, and shipped in
// one SSE frame. The browser must not fire three follow-up requests to fill
// in jobs and balance — the whole point is that the card is complete before
// the handset is picked up.

'use strict';

const { query } = require('../db/connection');
const { formatForDisplay } = require('./phone');

// projects.status_id is pipeline-ordered; 2..10 (Ordered → Billing) is the
// contiguous "in the shop" range — past Quote, not yet Complete/Hold/Service.
// Same definition as GET /api/projects/summary's stat strip; keep them equal.
const ACTIVE_STATUS_MIN = 2;   // Ordered
const ACTIVE_STATUS_MAX = 10;  // Billing

// Quotes (status 1) are not "in the shop", but a customer ringing about one
// they were sent last week is a very common call, and having it on the card
// is the difference between "let me look that up" and "yes, the monument
// sign — I have it here". Old quotes are noise, so only recent ones.
const QUOTE_STATUS = 1;
const QUOTE_WINDOW_DAYS = 90;

// How many open jobs to ship in the payload. A client with 30 open jobs would
// bloat the frame and overflow the card; the pop shows the newest few and the
// true count sits beside them.
const MAX_JOBS_IN_POP = 5;

// Every client whose indexed numbers include this one. Usually 0 or 1;
// several contacts sharing one shop line is normal and must NOT be guessed at.
async function matchClients(e164) {
  if (!e164) return [];
  return query(
    `SELECT DISTINCT c.id,
            COALESCE(c.company, CONCAT_WS(' ', c.fname, c.lname)) AS name,
            c.company,
            CONCAT_WS(' ', c.fname, c.lname) AS contact_name,
            c.email
       FROM client_phone_index i
       JOIN clients c ON c.id = i.client_id
      WHERE i.e164 = $1
      ORDER BY name`,
    [e164]
  );
}

// Everything worth mentioning to a caller: active jobs (Ordered → Billing)
// plus quotes from the last QUOTE_WINDOW_DAYS. Per-job value uses the same
// definition the job board does — manual line items + any linked online order.
//
// Active jobs sort first so that when a client has more of both than the card
// can show, it's the quotes that get cut, not the live work.
async function openJobs(clientId) {
  return query(
    `SELECT p.id,
            p.description,
            p.status_id,
            s.name AS status,
            (p.status_id = $4) AS is_quote,
            p.created_date,
            p.due_date,
            (COALESCE(iv.total, 0) + COALESCE(ov.total, 0))::numeric AS total
       FROM projects p
       LEFT JOIN status s ON s.id = p.status_id
       LEFT JOIN (SELECT project_id, SUM(ext_price)   AS total FROM items  GROUP BY project_id) iv
              ON iv.project_id = p.id
       LEFT JOIN (SELECT job_id,     SUM(grand_total) AS total FROM orders GROUP BY job_id)     ov
              ON ov.job_id     = p.id
      WHERE p.client_id = $1
        AND (
              p.status_id BETWEEN $2 AND $3
              OR (p.status_id = $4
                  AND p.created_date >= NOW() - ($5 * INTERVAL '1 day'))
            )
      ORDER BY (p.status_id = $4) ASC,
               p.created_date DESC NULLS LAST, p.id DESC`,
    [clientId, ACTIVE_STATUS_MIN, ACTIVE_STATUS_MAX, QUOTE_STATUS, QUOTE_WINDOW_DAYS]
  );
}

// What this client currently owes.
//
// ⚠ SCOPE: this is the unpaid total of ONLINE orders (orders.paid_at IS NULL,
// excluding cancelled/refunded). It is NOT accounts receivable — invoiced
// shop work is billed through QuickBooks and this database has no AR ledger
// to read. A client with a $12,000 overdue QBO invoice and no web orders
// shows $0 here. Wiring the real number means pulling the QBO customer
// balance (clients.qb_customer_id is already populated by routes/quickbooks
// .js) on a cached poll — deliberately out of Phase 1 scope, but the card
// labels this figure "unpaid orders" rather than "balance" so nobody reads
// it as gospel.
async function unpaidOrderTotal(clientId) {
  const rows = await query(
    `SELECT COALESCE(SUM(grand_total), 0)::numeric AS owed
       FROM orders
      WHERE client_id = $1
        AND paid_at IS NULL
        AND status NOT IN ('cancelled', 'refunded')`,
    [clientId]
  );
  return Number(rows[0]?.owed || 0);
}

// Full detail block for exactly one matched client.
async function clientCard(client) {
  const [jobs, unpaid] = await Promise.all([
    openJobs(client.id),
    unpaidOrderTotal(client.id),
  ]);
  const shown = jobs.slice(0, MAX_JOBS_IN_POP);
  const active = jobs.filter((j) => !j.is_quote);

  // Oldest ACTIVE job drives the "waiting since" line — the useful signal
  // when someone rings up asking where their sign is. A three-month-old quote
  // they never accepted would make that number lie.
  const oldest = active.reduce((acc, j) => {
    if (!j.created_date) return acc;
    if (!acc || new Date(j.created_date) < new Date(acc)) return j.created_date;
    return acc;
  }, null);

  return {
    id: client.id,
    name: client.name,
    company: client.company || null,
    contactName: client.contact_name || null,
    email: client.email || null,
    // Counted separately and deliberately: rolling quotes into "open jobs"
    // would turn "1 job in production" into "7 open jobs" and make the number
    // worthless at a glance.
    openJobCount: active.length,
    recentQuoteCount: jobs.length - active.length,
    oldestOpenJobAt: oldest,
    openJobs: shown.map((j) => ({
      number: j.id,
      description: j.description,
      status: j.status,
      isQuote: Boolean(j.is_quote),
      total: Number(j.total || 0),
      createdAt: j.created_date,
      dueDate: j.due_date,
    })),
    unpaidOrders: unpaid,
  };
}

// Build the SSE payload for a call event.
//
//   match: 'none' | 'one' | 'many' | 'internal' | 'anonymous'
// The client renders a different card per value; 'none' still pops, with a
// Create-customer shortcut pre-filled with the number.
async function buildPayload({ event, key, remoteRaw, remoteE164, localExt,
                              direction = 'inbound', handledBy = null,
                              matchKind = null }) {
  const base = {
    event,
    key,
    direction,
    remoteE164: remoteE164 || null,
    remoteRaw: remoteRaw ?? null,
    remoteDisplay: formatForDisplay(remoteE164 || remoteRaw),
    localExt: localExt || null,
    handledBy,
    at: new Date().toISOString(),
  };

  if (matchKind) return { ...base, match: matchKind, clients: [] };

  const matches = await matchClients(remoteE164);
  if (matches.length === 0) return { ...base, match: 'none', clients: [] };

  if (matches.length === 1) {
    return { ...base, match: 'one', clients: [await clientCard(matches[0])] };
  }

  // Several clients share this number. List them and let a human pick —
  // guessing here puts the wrong customer's job list on screen.
  return {
    ...base,
    match: 'many',
    clients: await Promise.all(matches.map(clientCard)),
  };
}

// Resolve $active_user (a desk extension) to a staff name for `handled_by`.
async function employeeNameForExtension(ext) {
  if (!ext) return null;
  try {
    const rows = await query(
      `SELECT CONCAT_WS(' ', first_name, last_name) AS name
         FROM employees
        WHERE phone_extension = $1
        LIMIT 1`,
      [String(ext)]
    );
    return rows[0]?.name || null;
  } catch {
    return null;
  }
}

module.exports = {
  buildPayload,
  matchClients,
  openJobs,
  unpaidOrderTotal,
  clientCard,
  employeeNameForExtension,
  ACTIVE_STATUS_MIN,
  ACTIVE_STATUS_MAX,
  QUOTE_STATUS,
  QUOTE_WINDOW_DAYS,
  MAX_JOBS_IN_POP,
};
