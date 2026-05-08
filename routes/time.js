// routes/time.js
// Time-clock endpoints for the staff time-tracking module.
// Mounted at /api/time. Schema in db/migrations/016_time_tracking.sql.
//
// Endpoints:
//   POST /clock-in              Open a new entry. 409 if already clocked in.
//   POST /clock-out             Close the caller's open entry. 404 if none.
//   POST /switch-job            Atomically clock-out + clock-in (per-job tracking).
//   GET  /me                    My entries in a date range, joined with project name.
//   GET  /me/current            Lightweight "am I clocked in right now?" probe.
//   GET  /admin                 All employees' entries (admin). from/to/employee_id/status filters.
//   PUT  /admin/:id             Edit an entry (admin). For correcting forgotten punches.
//   POST /admin/:id/approve     Mark an entry approved (admin).
//   POST /admin/bulk-approve    Approve a batch (admin).
//   GET  /admin/export          CSV export in QBO-friendly format (admin). Marks 'exported'.
//
// Conventions:
//   - All timestamps are TIMESTAMPTZ in the DB; clients send/receive ISO 8601.
//   - The DB enforces "one open entry per employee" via a unique partial index,
//     so concurrent clock-in attempts fail loudly rather than silently double up.
//   - Status flow: open → closed → approved → exported. Manual edits via PUT
//     can reverse the closed↔approved step if needed.
//
//   - Lunch deduction: per the shop's policy, an employee who works more than
//     4 hours total in a single calendar day (America/Toronto) has 30 minutes
//     deducted as unpaid lunch. Employees stay clocked in through lunch, so
//     the deduction is applied programmatically here rather than via a
//     manual punch-out. See computeLunchDeductions() below.

'use strict';

const express = require('express');
const { pool, query, queryOne } = require('../db/connection');
const { requireStaff, requireAdmin } = require('../middleware/auth');
const router = express.Router();

// ─── Lunch deduction policy ──────────────────────────────────────────────────
//
// Shop policy: > 4h worked in a calendar day (local time) ⇒ 30-min unpaid
// lunch. Applied to the longest entry of the day. If the longest entry is
// shorter than 30 min, cascade the remainder to the next-longest, until the
// full 30 minutes is accounted for. Open entries (clock_out IS NULL) are
// excluded — they're not yet payable.
//
// Calendar day uses the shop's local timezone so a 22:00 → 02:00 overnight
// shift (rare here, but) doesn't accidentally roll into two days under UTC.

const LUNCH_THRESHOLD_MIN = 240; // 4 hours
const LUNCH_DEDUCTION_MIN = 30;
const SHOP_TZ = 'America/Toronto';

const LOCAL_DATE_FMT = new Intl.DateTimeFormat('en-CA', {
  timeZone: SHOP_TZ,
  year: 'numeric', month: '2-digit', day: '2-digit',
});

// "YYYY-MM-DD" in shop-local time for any ISO/Date input.
function localDateKey(iso) {
  return LOCAL_DATE_FMT.format(new Date(iso));
}

// Given an array of raw DB rows, return Map<row.id, deduction_minutes>
// for the rows that should have a lunch deduction applied. Multi-entry
// days that exceed 4h get a 30-min total deduction, distributed onto the
// longest entry first, cascading if needed.
function computeLunchDeductions(rows) {
  const groups = new Map(); // key -> [{id, minutes}, ...]
  for (const r of rows) {
    if (!r.clock_out) continue;
    const minutes = Math.round(
      (new Date(r.clock_out) - new Date(r.clock_in)) / 60000
    );
    if (minutes <= 0) continue;
    const key = `${r.employee_id}:${localDateKey(r.clock_in)}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push({ id: r.id, minutes });
  }

  const deductions = new Map();
  for (const dayEntries of groups.values()) {
    const total = dayEntries.reduce((s, e) => s + e.minutes, 0);
    if (total <= LUNCH_THRESHOLD_MIN) continue;

    // Sort longest first; cascade until 30 min is fully deducted.
    const sorted = [...dayEntries].sort((a, b) => b.minutes - a.minutes);
    let remaining = LUNCH_DEDUCTION_MIN;
    for (const e of sorted) {
      if (remaining <= 0) break;
      const take = Math.min(e.minutes, remaining);
      if (take > 0) {
        deductions.set(e.id, (deductions.get(e.id) || 0) + take);
        remaining -= take;
      }
    }
  }
  return deductions;
}

// For single-entry endpoints (clock-out, edit, approve), we need the day's
// other entries to know whether/how much lunch to deduct. Fetch a 36h
// window around the entry, filter to the same local date, then compute.
async function deductionsForSingleEntry(row) {
  if (!row || !row.clock_in) return new Map();
  const center = new Date(row.clock_in).getTime();
  const lo = new Date(center - 36 * 3600 * 1000).toISOString();
  const hi = new Date(center + 36 * 3600 * 1000).toISOString();
  const siblings = await query(
    `SELECT id, employee_id, clock_in, clock_out
       FROM time_entries
      WHERE employee_id = $1 AND clock_in >= $2 AND clock_in < $3`,
    [row.employee_id, lo, hi]
  );
  const dayKey = localDateKey(row.clock_in);
  const sameDay = siblings.filter(r => localDateKey(r.clock_in) === dayKey);
  // Replace any stale sibling with our just-updated row, in case the
  // caller hands us an in-memory row newer than what's in the DB.
  const idx = sameDay.findIndex(r => r.id === row.id);
  if (idx >= 0) sameDay[idx] = row;
  else sameDay.push(row);
  return computeLunchDeductions(sameDay);
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

// Shape a DB row into the JSON we send to the frontend.
//   clock_minutes:  raw clock-out − clock-in (what was on the clock)
//   lunch_deduction_minutes: 0 or 30 (or whatever cascaded down)
//   paid_minutes:   clock_minutes − lunch_deduction_minutes (the payable number)
//   duration_minutes: alias for paid_minutes (the field the existing
//     frontend reads for tables/totals — kept so the dashboards keep
//     summing correctly without further frontend changes).
function formatEntry(row, deductions) {
  if (!row) return null;
  const clockMinutes = row.clock_out
    ? Math.round((new Date(row.clock_out) - new Date(row.clock_in)) / 60000)
    : null;
  const lunch = (deductions && deductions.get(row.id)) || 0;
  const paidMinutes = clockMinutes == null
    ? null
    : Math.max(0, clockMinutes - lunch);
  return {
    id:                row.id,
    employee_id:       row.employee_id,
    employee_name:     row.employee_name || null,
    clock_in:          row.clock_in,
    clock_out:         row.clock_out,
    clock_minutes:     clockMinutes,
    lunch_deduction_minutes: lunch,
    paid_minutes:      paidMinutes,
    duration_minutes:  paidMinutes,
    project_id:        row.project_id,
    project_name:      row.project_name || null,
    notes:             row.notes,
    status:            row.status,
    approved_by:       row.approved_by,
    approved_by_name:  row.approved_by_name || null,
    approved_at:       row.approved_at,
    created_at:        row.created_at,
    updated_at:        row.updated_at,
  };
}

// SELECT clause used everywhere we return time_entries to the client. Joins
// employees (and approver) and projects so the frontend gets readable names
// instead of bare ids.
//
// NOTE: projects.description is the real "name" column on the projects table;
// the rest of the codebase aliases it `AS project_name` (see routes/projects.js
// lines 103, 254). We follow the same convention here so the frontend gets a
// consistent shape regardless of which endpoint produced it.
const SELECT_WITH_JOINS = `
  SELECT t.*,
         TRIM(CONCAT_WS(' ', e.first_name, e.last_name)) AS employee_name,
         TRIM(CONCAT_WS(' ', a.first_name, a.last_name)) AS approved_by_name,
         p.description AS project_name
    FROM time_entries t
    LEFT JOIN employees e ON e.id = t.employee_id
    LEFT JOIN employees a ON a.id = t.approved_by
    LEFT JOIN projects  p ON p.id = t.project_id
`;

// Validate ISO date string (or date-only) — used by query string ?from/?to.
function parseDateParam(s) {
  if (!s) return null;
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? null : d;
}

// CSV escape: wrap in quotes and double-up internal quotes if the field
// contains a delimiter, quote, or newline. Otherwise return as-is.
function csvEscape(v) {
  if (v == null) return '';
  const s = String(v);
  if (/[",\n\r]/.test(s)) {
    return `"${s.replace(/"/g, '""')}"`;
  }
  return s;
}

// ─── POST /api/time/clock-in ─────────────────────────────────────────────────
// Body: { project_id?: int, notes?: string }
// 201: returns the new entry. 409 if already clocked in.
router.post('/clock-in', requireStaff, async (req, res) => {
  const { project_id, notes } = req.body || {};
  const employeeId = req.user?.id;
  if (!Number.isInteger(employeeId)) {
    return res.status(500).json({ message: 'Auth context missing employee id' });
  }
  try {
    const inserted = await queryOne(
      `INSERT INTO time_entries (employee_id, clock_in, project_id, notes, status)
       VALUES ($1, NOW(), $2, $3, 'open')
       RETURNING id`,
      [employeeId, project_id || null, notes || null]
    );
    const full = await queryOne(
      `${SELECT_WITH_JOINS} WHERE t.id = $1`,
      [inserted.id]
    );
    res.status(201).json(formatEntry(full));
  } catch (e) {
    // The unique partial index `idx_time_entries_one_open_per_employee` throws
    // a unique-violation if there's already an open entry. Surface as 409 so
    // the client can show "you're already clocked in" instead of a 500.
    if (e.code === '23505') {
      return res.status(409).json({ message: 'Already clocked in. Clock out first.' });
    }
    console.error('POST /api/time/clock-in failed:', e);
    res.status(500).json({ message: 'Clock-in failed', detail: e.message });
  }
});

// ─── POST /api/time/clock-out ────────────────────────────────────────────────
// Body: { notes?: string } — optional, appended/replaces the entry's notes.
router.post('/clock-out', requireStaff, async (req, res) => {
  const employeeId = req.user?.id;
  const { notes } = req.body || {};
  try {
    const open = await queryOne(
      `SELECT id FROM time_entries WHERE employee_id = $1 AND status = 'open'`,
      [employeeId]
    );
    if (!open) {
      return res.status(404).json({ message: 'No open entry to clock out.' });
    }
    await query(
      `UPDATE time_entries
          SET clock_out = NOW(),
              status = 'closed',
              notes = COALESCE($2, notes)
        WHERE id = $1`,
      [open.id, notes || null]
    );
    const full = await queryOne(`${SELECT_WITH_JOINS} WHERE t.id = $1`, [open.id]);
    const deductions = await deductionsForSingleEntry(full);
    res.json(formatEntry(full, deductions));
  } catch (e) {
    console.error('POST /api/time/clock-out failed:', e);
    res.status(500).json({ message: 'Clock-out failed', detail: e.message });
  }
});

// ─── POST /api/time/switch-job ───────────────────────────────────────────────
// Body: { project_id: int, notes?: string }
// Atomically: close current open entry → open a new one with the new project_id.
// Used by the "Switch Job" button on the time-clock page (Phase 1.5 wires the UI;
// Phase 1 still works for staff who hit the API directly).
router.post('/switch-job', requireStaff, async (req, res) => {
  const employeeId = req.user?.id;
  const { project_id, notes } = req.body || {};
  if (!Number.isInteger(project_id)) {
    return res.status(400).json({ message: 'project_id (integer) required' });
  }
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const open = await client.query(
      `SELECT id FROM time_entries
        WHERE employee_id = $1 AND status = 'open'
        FOR UPDATE`,
      [employeeId]
    );
    if (open.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({
        message: 'No open entry to switch from. Use /clock-in instead.',
      });
    }
    await client.query(
      `UPDATE time_entries SET clock_out = NOW(), status = 'closed' WHERE id = $1`,
      [open.rows[0].id]
    );
    const ins = await client.query(
      `INSERT INTO time_entries (employee_id, clock_in, project_id, notes, status)
       VALUES ($1, NOW(), $2, $3, 'open')
       RETURNING id`,
      [employeeId, project_id, notes || null]
    );
    await client.query('COMMIT');
    const full = await queryOne(
      `${SELECT_WITH_JOINS} WHERE t.id = $1`,
      [ins.rows[0].id]
    );
    res.status(201).json(formatEntry(full));
  } catch (e) {
    try { await client.query('ROLLBACK'); } catch {}
    console.error('POST /api/time/switch-job failed:', e);
    res.status(500).json({ message: 'Switch-job failed', detail: e.message });
  } finally {
    client.release();
  }
});

// ─── GET /api/time/me/current ────────────────────────────────────────────────
// Lightweight "am I clocked in right now?" — used by the UI to render the
// Clock In vs Clock Out button on every page load. Returns the open entry or null.
router.get('/me/current', requireStaff, async (req, res) => {
  const employeeId = req.user?.id;
  try {
    const row = await queryOne(
      `${SELECT_WITH_JOINS}
        WHERE t.employee_id = $1 AND t.status = 'open'
        LIMIT 1`,
      [employeeId]
    );
    res.json(row ? formatEntry(row) : null);
  } catch (e) {
    console.error('GET /api/time/me/current failed:', e);
    res.status(500).json({ message: 'Lookup failed', detail: e.message });
  }
});

// ─── GET /api/time/me ────────────────────────────────────────────────────────
// Query: ?from=ISO&to=ISO (optional; defaults to last 14 days)
// Returns the caller's entries in the range, newest first, with totals.
//
// total_minutes / total_hours are the PAID totals (lunch deductions applied).
// gross_minutes / gross_hours are the raw clock totals before deduction.
router.get('/me', requireStaff, async (req, res) => {
  const employeeId = req.user?.id;
  const to   = parseDateParam(req.query.to)   || new Date();
  const from = parseDateParam(req.query.from) || new Date(Date.now() - 14 * 86400 * 1000);
  try {
    const rows = await query(
      `${SELECT_WITH_JOINS}
        WHERE t.employee_id = $1
          AND t.clock_in >= $2
          AND t.clock_in <  $3
        ORDER BY t.clock_in DESC`,
      [employeeId, from.toISOString(), to.toISOString()]
    );
    const deductions = computeLunchDeductions(rows);
    const entries = rows.map(r => formatEntry(r, deductions));
    const grossMinutes = entries.reduce((s, e) => s + (e.clock_minutes || 0), 0);
    const lunchMinutes = entries.reduce((s, e) => s + (e.lunch_deduction_minutes || 0), 0);
    const paidMinutes  = entries.reduce((s, e) => s + (e.paid_minutes || 0), 0);
    res.json({
      from: from.toISOString(),
      to:   to.toISOString(),
      gross_minutes:           grossMinutes,
      gross_hours:             Math.round(grossMinutes / 60 * 100) / 100,
      lunch_deduction_minutes: lunchMinutes,
      total_minutes:           paidMinutes,
      total_hours:             Math.round(paidMinutes / 60 * 100) / 100,
      entries,
    });
  } catch (e) {
    console.error('GET /api/time/me failed:', e);
    res.status(500).json({ message: 'Lookup failed', detail: e.message });
  }
});

// ─── GET /api/time/admin ─────────────────────────────────────────────────────
// Query: ?from=ISO&to=ISO&employee_id=int&status=open|closed|approved|exported
router.get('/admin', requireAdmin, async (req, res) => {
  const to   = parseDateParam(req.query.to)   || new Date();
  const from = parseDateParam(req.query.from) || new Date(Date.now() - 14 * 86400 * 1000);
  const empId = req.query.employee_id ? parseInt(req.query.employee_id, 10) : null;
  const status = req.query.status || null;

  const wheres = ['t.clock_in >= $1', 't.clock_in < $2'];
  const params = [from.toISOString(), to.toISOString()];
  if (empId) { wheres.push(`t.employee_id = $${params.length + 1}`); params.push(empId); }
  if (status) { wheres.push(`t.status = $${params.length + 1}`); params.push(status); }

  try {
    const rows = await query(
      `${SELECT_WITH_JOINS}
        WHERE ${wheres.join(' AND ')}
        ORDER BY t.employee_id, t.clock_in DESC`,
      params
    );
    const deductions = computeLunchDeductions(rows);
    res.json({
      from: from.toISOString(),
      to:   to.toISOString(),
      count: rows.length,
      entries: rows.map(r => formatEntry(r, deductions)),
    });
  } catch (e) {
    console.error('GET /api/time/admin failed:', e);
    res.status(500).json({ message: 'Lookup failed', detail: e.message });
  }
});

// ─── PUT /api/time/admin/:id ─────────────────────────────────────────────────
// Body: any subset of { clock_in, clock_out, project_id, notes, status }
// For correcting forgotten punches, fixing typos, manual approval reversal.
router.put('/admin/:id', requireAdmin, async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!Number.isInteger(id)) {
    return res.status(400).json({ message: 'invalid id' });
  }
  const allowed = ['clock_in', 'clock_out', 'project_id', 'notes', 'status'];
  const sets = [];
  const params = [];
  for (const field of allowed) {
    if (req.body && Object.prototype.hasOwnProperty.call(req.body, field)) {
      params.push(req.body[field]);
      sets.push(`${field} = $${params.length}`);
    }
  }
  if (sets.length === 0) {
    return res.status(400).json({ message: 'No editable fields provided.' });
  }
  params.push(id);
  try {
    const result = await query(
      `UPDATE time_entries SET ${sets.join(', ')} WHERE id = $${params.length} RETURNING id`,
      params
    );
    if (result.length === 0) {
      return res.status(404).json({ message: 'Entry not found.' });
    }
    const full = await queryOne(`${SELECT_WITH_JOINS} WHERE t.id = $1`, [id]);
    const deductions = await deductionsForSingleEntry(full);
    res.json(formatEntry(full, deductions));
  } catch (e) {
    // Edits can violate the CHECK constraints (e.g., setting clock_out before
    // clock_in, or setting status='open' while clock_out is set). Surface as 400.
    if (e.code === '23514') {
      return res.status(400).json({
        message: 'Edit violates constraint',
        detail: e.message,
      });
    }
    console.error('PUT /api/time/admin/:id failed:', e);
    res.status(500).json({ message: 'Edit failed', detail: e.message });
  }
});

// ─── POST /api/time/admin/:id/approve ────────────────────────────────────────
router.post('/admin/:id/approve', requireAdmin, async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!Number.isInteger(id)) {
    return res.status(400).json({ message: 'invalid id' });
  }
  try {
    const updated = await query(
      `UPDATE time_entries
          SET status = 'approved',
              approved_by = $1,
              approved_at = NOW()
        WHERE id = $2 AND status = 'closed'
        RETURNING id`,
      [req.user.id, id]
    );
    if (updated.length === 0) {
      return res.status(409).json({
        message: 'Entry not approvable (not found, still open, or already past closed).',
      });
    }
    const full = await queryOne(`${SELECT_WITH_JOINS} WHERE t.id = $1`, [id]);
    const deductions = await deductionsForSingleEntry(full);
    res.json(formatEntry(full, deductions));
  } catch (e) {
    console.error('POST /api/time/admin/:id/approve failed:', e);
    res.status(500).json({ message: 'Approve failed', detail: e.message });
  }
});

// ─── POST /api/time/admin/bulk-approve ───────────────────────────────────────
// Body: { ids: [int, ...] }  — only entries currently 'closed' will flip.
router.post('/admin/bulk-approve', requireAdmin, async (req, res) => {
  const ids = Array.isArray(req.body?.ids) ? req.body.ids.filter(Number.isInteger) : [];
  if (ids.length === 0) {
    return res.status(400).json({ message: 'ids array (integers) required' });
  }
  try {
    const updated = await query(
      `UPDATE time_entries
          SET status = 'approved',
              approved_by = $1,
              approved_at = NOW()
        WHERE id = ANY($2::int[]) AND status = 'closed'
        RETURNING id`,
      [req.user.id, ids]
    );
    res.json({ approved_count: updated.length, approved_ids: updated.map(r => r.id) });
  } catch (e) {
    console.error('POST /api/time/admin/bulk-approve failed:', e);
    res.status(500).json({ message: 'Bulk approve failed', detail: e.message });
  }
});

// ─── GET /api/time/admin/export ──────────────────────────────────────────────
// Query: one of two modes:
//   Pay-period mode (preferred):  ?pay_period_id=<int>
//     Filters by pay_period_id directly. After successful export (when
//     mark_exported=true) the pay_periods row is also marked exported with
//     audit metadata: exported_at, exported_by, csv_filename, exported_count.
//   Date-range mode (fallback):  ?from=YYYY-MM-DD&to=YYYY-MM-DD
//     For ad-hoc exports outside the regular pay cycle.
//
// Common flags:
//   ?include_open=true|false      default false (open entries have no
//                                 clock_out, can't compute duration)
//   ?mark_exported=true|false     default true; pass false for a "preview"
//                                 download that doesn't flip status
//
// Streams CSV in QBO Time Tracking format. The Duration column is PAID
// hours (lunch deduction applied per shop policy: > 4h/day ⇒ -30 min).
// By default excludes already-'exported' entries so re-running the same
// period doesn't double-count.
router.get('/admin/export', requireAdmin, async (req, res) => {
  const payPeriodId = req.query.pay_period_id
    ? parseInt(req.query.pay_period_id, 10)
    : null;
  const includeOpen = req.query.include_open === 'true';
  const markExported = req.query.mark_exported !== 'false';

  // Build the entry-selection WHERE based on which mode we're in.
  let wheres = ["t.status <> 'exported'"];
  const params = [];
  let payPeriod = null;

  if (Number.isInteger(payPeriodId)) {
    payPeriod = await queryOne('SELECT * FROM pay_periods WHERE id = $1', [payPeriodId]);
    if (!payPeriod) {
      return res.status(404).json({ message: 'Pay period not found.' });
    }
    wheres.push(`t.pay_period_id = $${params.length + 1}`);
    params.push(payPeriodId);
  } else {
    const to   = parseDateParam(req.query.to)   || new Date();
    const from = parseDateParam(req.query.from) || new Date(Date.now() - 14 * 86400 * 1000);
    wheres.push(`t.clock_in >= $${params.length + 1}`);
    params.push(from.toISOString());
    wheres.push(`t.clock_in <  $${params.length + 1}`);
    params.push(to.toISOString());
  }

  if (!includeOpen) {
    wheres.push("t.status <> 'open'");
  }

  try {
    const rows = await query(
      `${SELECT_WITH_JOINS}
        WHERE ${wheres.join(' AND ')}
        ORDER BY t.employee_id, t.clock_in`,
      params
    );

    // Lunch deduction is computed across all returned rows so each
    // (employee, day) group sees its full set of entries.
    const deductions = computeLunchDeductions(rows);

    // Build CSV. Header matches QBO Online's "Weekly Timesheet" import shape;
    // also paste-friendly into other payroll tools.
    const headers = ['Date', 'Employee', 'Job', 'Service', 'Duration', 'Notes', 'Billable'];
    const lines = [headers.join(',')];

    for (const r of rows) {
      const date = new Date(r.clock_in).toISOString().slice(0, 10); // YYYY-MM-DD
      const employee = (r.employee_name || `Emp #${r.employee_id}`).trim();
      const job = r.project_id
        ? `Job ${r.project_id}${r.project_name ? ' - ' + r.project_name : ''}`
        : '';
      const service = ''; // Phase 1: no Service Item mapping yet
      const clockMinutes = r.clock_out
        ? Math.round((new Date(r.clock_out) - new Date(r.clock_in)) / 60000)
        : 0;
      const lunchMinutes = deductions.get(r.id) || 0;
      const paidMinutes  = Math.max(0, clockMinutes - lunchMinutes);
      const durationHours = Math.round(paidMinutes / 60 * 100) / 100;
      // Annotate the notes column when a deduction was applied so the
      // payroll reviewer can see the reason at a glance.
      let notes = r.notes || '';
      if (lunchMinutes > 0) {
        const tag = `[lunch -${lunchMinutes}m]`;
        notes = notes ? `${notes} ${tag}` : tag;
      }
      const billable = r.project_id ? 'Y' : 'N';
      lines.push([
        csvEscape(date),
        csvEscape(employee),
        csvEscape(job),
        csvEscape(service),
        csvEscape(durationHours.toFixed(2)),
        csvEscape(notes),
        csvEscape(billable),
      ].join(','));
    }

    // Filename reflects the source: pay period in pay-period mode, raw range
    // in date-range mode. Easier to find on disk later when reconciling.
    let filename;
    if (payPeriod) {
      filename = `timesheet-PP-${payPeriod.start_date}-to-${payPeriod.end_date}.csv`;
    } else {
      const from = parseDateParam(req.query.from) || new Date(Date.now() - 14 * 86400 * 1000);
      const to   = parseDateParam(req.query.to)   || new Date();
      filename = `timesheet-${from.toISOString().slice(0, 10)}-to-${to.toISOString().slice(0, 10)}.csv`;
    }

    if (markExported && rows.length > 0) {
      const ids = rows.map(r => r.id);
      // Flip individual entries first.
      await query(
        `UPDATE time_entries SET status = 'exported' WHERE id = ANY($1::int[])`,
        [ids]
      );
      // If we're in pay-period mode, also stamp the period as exported with
      // audit metadata. /admin/pay-periods/:id/reopen can revert if needed.
      if (payPeriod) {
        await query(
          `UPDATE pay_periods
              SET status = 'exported',
                  exported_at = NOW(),
                  exported_by = $2,
                  csv_filename = $3,
                  exported_count = $4
            WHERE id = $1`,
          [payPeriod.id, req.user.id, filename, rows.length]
        );
      }
    }

    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.setHeader('X-Exported-Count', rows.length);
    res.setHeader('X-Marked-Exported', markExported ? 'true' : 'false');
    if (payPeriod) res.setHeader('X-Pay-Period-Id', payPeriod.id);
    res.send(lines.join('\n') + '\n');
  } catch (e) {
    console.error('GET /api/time/admin/export failed:', e);
    res.status(500).json({ message: 'Export failed', detail: e.message });
  }
});

module.exports = router;
