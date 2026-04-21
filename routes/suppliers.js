// routes/suppliers.js
//
// Admin endpoints for managing apparel supplier integrations.
// Mounted at /api/suppliers. Everything here requires admin role.
//
// Public-facing catalog browse endpoints live in routes/catalog.js.

const express = require('express');
const { query, queryOne } = require('../db/connection');
const { requireAdmin } = require('../middleware/auth');
const { runSanmarIngest } = require('../suppliers/sanmar/ingest');
const { backfillCategories } = require('../suppliers/sanmar/category-backfill');

const router = express.Router();

// ─── GET /api/suppliers ──────────────────────────────────────────────────────
// List all registered suppliers + their most recent successful ingest.
router.get('/', requireAdmin, async (req, res) => {
  try {
    const rows = await query(`
      SELECT
        s.id,
        s.code,
        s.name,
        s.api_kind,
        s.active,
        (SELECT MAX(ended_at) FROM sync_run r
           WHERE r.supplier_id = s.id AND r.kind = 'bulk_data' AND r.status = 'success'
        ) AS last_bulk_data_success,
        (SELECT COUNT(*) FROM supplier_product p
           WHERE p.supplier_id = s.id
        )::int AS product_count,
        (SELECT COUNT(*) FROM supplier_variant v
            JOIN supplier_product p ON p.id = v.product_id
           WHERE p.supplier_id = s.id
        )::int AS variant_count
      FROM supplier s
      ORDER BY s.id
    `);
    res.json(rows);
  } catch (e) {
    console.error('GET /suppliers:', e);
    res.status(500).json({ message: 'Failed to list suppliers', detail: e.message });
  }
});

// ─── POST /api/suppliers/sanmar/ingest ───────────────────────────────────────
// Run the SanMar Bulk Data ingest right now. Synchronous — expect this to
// take several minutes on a full catalog. Bump client timeout when invoking
// from a browser (or just call via `curl` / Railway scheduled job).
router.post('/sanmar/ingest', requireAdmin, async (req, res) => {
  const logs = [];
  try {
    const result = await runSanmarIngest({ log: (m) => logs.push(m) });
    res.json({ ok: true, ...result, logs });
  } catch (e) {
    console.error('sanmar ingest:', e);
    res.status(500).json({
      ok: false,
      message: 'SanMar ingest failed',
      detail: e.message,
      logs,
    });
  }
});

// ─── POST /api/suppliers/sanmar/category-backfill ────────────────────────────
// One-shot trigger for the SanMar category-backfill job. Runs synchronously
// inside the API process — i.e. on Railway, where postgres.railway.internal
// resolves and SANMAR_* creds are in scope. Local CLI runs hit a network
// wall, so the browser/curl trigger is the supported path.
//
// Query params:
//   ?refresh=1  → re-sync every row (default: only NULL rows)
//   ?limit=N    → cap to N styles (use for a smoke test)
//   ?rate=N     → ms between SOAP calls (default 300)
//
// Total runtime is roughly  styles × rate / 1000  seconds + network. The
// HTTP request blocks until done — bump your client timeout for full runs.
// Output is the same per-style log lines the CLI produces, returned as JSON.
router.post('/sanmar/category-backfill', requireAdmin, async (req, res) => {
  const logs = [];
  const refresh = req.query.refresh === '1' || req.query.refresh === 'true';
  const limit   = req.query.limit ? Number(req.query.limit) : null;
  const rateMs  = req.query.rate  ? Number(req.query.rate)  : undefined;
  try {
    const result = await backfillCategories({
      refresh,
      limit,
      rateMs,
      log: (m) => logs.push(m),
    });
    res.json({ ok: true, ...result, logs });
  } catch (e) {
    console.error('sanmar category-backfill:', e);
    res.status(500).json({
      ok: false,
      message: 'SanMar category backfill failed',
      detail: e.message,
      logs,
    });
  }
});

// ─── GET /api/suppliers/:id/sync-runs ────────────────────────────────────────
// Recent ingest history for a supplier. Used by the admin console to show
// "last synced 2h ago" status and spot repeated failures.
router.get('/:id/sync-runs', requireAdmin, async (req, res) => {
  const supplierId = parseInt(req.params.id, 10);
  const limit = Math.min(parseInt(req.query.limit, 10) || 25, 200);
  if (!Number.isInteger(supplierId)) {
    return res.status(400).json({ message: 'supplier id must be integer' });
  }
  try {
    const rows = await query(
      `SELECT id, supplier_id, kind, status, started_at, ended_at,
              products_upserted, variants_upserted, error_message
         FROM sync_run
        WHERE supplier_id = $1
        ORDER BY started_at DESC
        LIMIT $2`,
      [supplierId, limit],
    );
    res.json(rows);
  } catch (e) {
    console.error('GET /suppliers/:id/sync-runs:', e);
    res.status(500).json({ message: 'Failed to load sync runs', detail: e.message });
  }
});

// ─── GET /api/suppliers/sync-runs/:runId ─────────────────────────────────────
// Single-run detail including any error body.
router.get('/sync-runs/:runId', requireAdmin, async (req, res) => {
  const runId = parseInt(req.params.runId, 10);
  if (!Number.isInteger(runId)) {
    return res.status(400).json({ message: 'run id must be integer' });
  }
  try {
    const row = await queryOne(
      `SELECT * FROM sync_run WHERE id = $1`,
      [runId],
    );
    if (!row) return res.status(404).json({ message: 'Sync run not found' });
    res.json(row);
  } catch (e) {
    console.error('GET /suppliers/sync-runs/:runId:', e);
    res.status(500).json({ message: 'Failed to load sync run', detail: e.message });
  }
});

module.exports = router;
