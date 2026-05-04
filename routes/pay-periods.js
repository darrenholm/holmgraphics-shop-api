// routes/pay-periods.js
// Pay-period management for the time-tracking module.
// Mounted at /api/pay-periods. Schema in db/migrations/017_pay_periods.sql.
//
// Endpoints:
//   GET  /                      List periods (filters: ?status, ?from, ?to)
//   GET  /current               Today's active period (lightweight UI probe)
//   GET  /:id                   Single period detail with rollup counts
//   POST /admin/extend          Generate next N future periods (default 2)
//   POST /admin/:id/close       Mark period closed (locks new edits)
//   POST /admin/:id/reopen      Recovery: revert closed/exported → open
//
// Conventions:
//   - Pay periods are 14-day Thursday-to-Wednesday windows starting from the
//     anchor date Apr 30, 2026. Migration 017 seeds the initial set; this API
//     extends them on demand as the calendar moves forward.
//   - Period status: open → closed → exported. Independent of the per-entry
//     status on individual time_entries.
//   - The actual CSV export is in routes/time.js — that endpoint marks the
//     period as exported when the download completes.

'use strict';

const express = require('express');
const { query, queryOne } = require('../db/connection');
const { requireStaff, requireAdmin } = require('../middleware/auth');
const router = express.Router();

// SELECT used for all list/detail responses. Joins the exporting employee
// for display ("Exported by Darren Holm on May 18") and computes per-status
// rollup counts so the UI can show "12 entries / 8 closed / 4 approved"
// at a glance without N+1 queries.
const SELECT_WITH_TOTALS = `
  SELECT pp.*,
         (SELECT COUNT(*) FROM time_entries t
            WHERE t.pay_period_id = pp.id) AS entry_count,
         (SELECT COUNT(*) FROM time_entries t
            WHERE t.pay_period_id = pp.id AND t.status = 'open')     AS open_count,
         (SELECT COUNT(*) FROM time_entries t
            WHERE t.pay_period_id = pp.id AND t.status = 'closed')   AS closed_count,
         (SELECT COUNT(*) FROM time_entries t
            WHERE t.pay_period_id = pp.id AND t.status = 'approved') AS approved_count,
         (SELECT COUNT(*) FROM time_entries t
            WHERE t.pay_period_id = pp.id AND t.status = 'exported') AS exported_count_actual,
         TRIM(CONCAT_WS(' ', e.first_name, e.last_name)) AS exported_by_name
    FROM pay_periods pp
    LEFT JOIN employees e ON e.id = pp.exported_by
`;

function formatPeriod(row) {
  if (!row) return null;
  return {
    id:               row.id,
    start_date:       row.start_date,
    end_date:         row.end_date,
    pay_date:         row.pay_date,
    status:           row.status,
    exported_at:      row.exported_at,
    exported_by:      row.exported_by,
    exported_by_name: row.exported_by_name || null,
    csv_filename:     row.csv_filename,
    exported_count:   row.exported_count,
    entry_count:           parseInt(row.entry_count           || 0, 10),
    open_count:            parseInt(row.open_count            || 0, 10),
    closed_count:          parseInt(row.closed_count          || 0, 10),
    approved_count:        parseInt(row.approved_count        || 0, 10),
    exported_count_actual: parseInt(row.exported_count_actual || 0, 10),
    created_at:       row.created_at,
    updated_at:       row.updated_at,
  };
}

function parseDateParam(s) {
  if (!s) return null;
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? null : d;
}

// ─── GET /api/pay-periods ────────────────────────────────────────────────────
// Filters (all optional):
//   ?status=open|closed|exported
//   ?from=ISO  pp.end_date >= from   (period must end at or after `from`)
//   ?to=ISO    pp.start_date <= to   (period must start at or before `to`)
router.get('/', requireStaff, async (req, res) => {
  const wheres = [];
  const params = [];
  if (req.query.status) {
    wheres.push(`pp.status = $${params.length + 1}`);
    params.push(req.query.status);
  }
  const fromD = parseDateParam(req.query.from);
  const toD   = parseDateParam(req.query.to);
  if (fromD) {
    wheres.push(`pp.end_date >= $${params.length + 1}`);
    params.push(fromD.toISOString().slice(0, 10));
  }
  if (toD) {
    wheres.push(`pp.start_date <= $${params.length + 1}`);
    params.push(toD.toISOString().slice(0, 10));
  }
  const whereClause = wheres.length ? 'WHERE ' + wheres.join(' AND ') : '';
  try {
    const rows = await query(
      `${SELECT_WITH_TOTALS} ${whereClause} ORDER BY pp.start_date DESC`,
      params
    );
    res.json({ count: rows.length, periods: rows.map(formatPeriod) });
  } catch (e) {
    console.error('GET /api/pay-periods failed:', e);
    res.status(500).json({ message: 'Lookup failed', detail: e.message });
  }
});

// ─── GET /api/pay-periods/current ────────────────────────────────────────────
// Returns the period containing CURRENT_DATE. 404 if none exists, which
// indicates the seeded windows have run out and admin needs to extend.
router.get('/current', requireStaff, async (req, res) => {
  try {
    const row = await queryOne(
      `${SELECT_WITH_TOTALS}
        WHERE CURRENT_DATE >= pp.start_date AND CURRENT_DATE <= pp.end_date
        LIMIT 1`,
      []
    );
    if (!row) {
      return res.status(404).json({
        message: 'No pay period exists for today. Run POST /api/pay-periods/admin/extend.',
      });
    }
    res.json(formatPeriod(row));
  } catch (e) {
    console.error('GET /api/pay-periods/current failed:', e);
    res.status(500).json({ message: 'Lookup failed', detail: e.message });
  }
});

// ─── GET /api/pay-periods/:id ────────────────────────────────────────────────
router.get('/:id', requireStaff, async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!Number.isInteger(id)) return res.status(400).json({ message: 'invalid id' });
  try {
    const row = await queryOne(`${SELECT_WITH_TOTALS} WHERE pp.id = $1`, [id]);
    if (!row) return res.status(404).json({ message: 'not found' });
    res.json(formatPeriod(row));
  } catch (e) {
    console.error('GET /api/pay-periods/:id failed:', e);
    res.status(500).json({ message: 'Lookup failed', detail: e.message });
  }
});

// ─── POST /api/pay-periods/admin/extend ──────────────────────────────────────
// Body: { n?: int, default 2 }. Generates the next N pay periods starting
// 14 days after the most recent existing period. Idempotent — uses
// ON CONFLICT (start_date) DO NOTHING so re-runs don't create duplicates.
router.post('/admin/extend', requireAdmin, async (req, res) => {
  const n = Math.min(Math.max(parseInt(req.body?.n || 2, 10), 1), 26);
  try {
    const last = await queryOne(
      `SELECT start_date FROM pay_periods ORDER BY start_date DESC LIMIT 1`
    );
    if (!last) {
      return res.status(409).json({
        message: 'No anchor period exists. Migration 017 seeds the initial set; '
          + 'something is wrong if this table is empty.',
      });
    }
    const startBase = new Date(last.start_date);
    const created = [];
    for (let i = 1; i <= n; i++) {
      const s = new Date(startBase);
      s.setUTCDate(s.getUTCDate() + 14 * i);
      const e = new Date(s);
      e.setUTCDate(e.getUTCDate() + 13);
      const p = new Date(e);
      p.setUTCDate(p.getUTCDate() + 5);
      const inserted = await queryOne(
        `INSERT INTO pay_periods (start_date, end_date, pay_date, status)
         VALUES ($1, $2, $3, 'open')
         ON CONFLICT (start_date) DO NOTHING
         RETURNING *`,
        [s.toISOString().slice(0, 10),
         e.toISOString().slice(0, 10),
         p.toISOString().slice(0, 10)]
      );
      if (inserted) created.push(formatPeriod(inserted));
    }
    res.json({ created_count: created.length, created });
  } catch (e) {
    console.error('POST /api/pay-periods/admin/extend failed:', e);
    res.status(500).json({ message: 'Extend failed', detail: e.message });
  }
});

// ─── POST /api/pay-periods/admin/:id/close ───────────────────────────────────
// Manual close: locks the period so no further edits should be made. The
// per-entry CHECK constraints don't enforce this — it's an admin signal —
// but the UI uses it to gate the Approve / Edit actions on /admin/timesheets.
router.post('/admin/:id/close', requireAdmin, async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!Number.isInteger(id)) return res.status(400).json({ message: 'invalid id' });
  try {
    const updated = await queryOne(
      `UPDATE pay_periods SET status = 'closed' WHERE id = $1 AND status = 'open' RETURNING *`,
      [id]
    );
    if (!updated) {
      return res.status(409).json({ message: 'Period not closable (not found or not open).' });
    }
    res.json(formatPeriod(updated));
  } catch (e) {
    console.error('POST /api/pay-periods/admin/:id/close failed:', e);
    res.status(500).json({ message: 'Close failed', detail: e.message });
  }
});

// ─── POST /api/pay-periods/admin/:id/reopen ──────────────────────────────────
// Recovery hatch: clears exported metadata + reverts status to open. Use this
// if a period was exported in error and you need to re-process. Doesn't undo
// what QBO already received — manual cleanup there is on you.
router.post('/admin/:id/reopen', requireAdmin, async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!Number.isInteger(id)) return res.status(400).json({ message: 'invalid id' });
  try {
    const updated = await queryOne(
      `UPDATE pay_periods
          SET status = 'open',
              exported_at = NULL,
              exported_by = NULL,
              csv_filename = NULL,
              exported_count = NULL
        WHERE id = $1
        RETURNING *`,
      [id]
    );
    if (!updated) return res.status(404).json({ message: 'not found' });
    res.json(formatPeriod(updated));
  } catch (e) {
    console.error('POST /api/pay-periods/admin/:id/reopen failed:', e);
    res.status(500).json({ message: 'Reopen failed', detail: e.message });
  }
});

module.exports = router;
