// routes/suppliers.js
//
// Admin endpoints for managing apparel supplier integrations.
// Mounted at /api/suppliers. Everything here requires admin role.
//
// Public-facing catalog browse endpoints live in routes/catalog.js.

const express = require('express');
const { pool, query, queryOne } = require('../db/connection');
const { requireAdmin } = require('../middleware/auth');
const { runSanmarIngest } = require('../suppliers/sanmar/ingest');
const { backfillCategories } = require('../suppliers/sanmar/category-backfill');
const { backfillMedia } = require('../suppliers/sanmar/media-backfill');
const { loadConfig: loadSanmarConfig } = require('../suppliers/sanmar/config');
const { getProduct: getSanmarProduct } = require('../suppliers/promostandards/product-data');
const { getMediaContent: getSanmarMedia } = require('../suppliers/promostandards/media-content');
const { lookupHex: lookupSanmarHex } = require('../suppliers/sanmar/color-hex-map');

const router = express.Router();

// ─── GET /api/suppliers/sanmar/debug-product?style=PC54 ──────────────────────
// Diagnostic: return the raw parsed getProduct() response so we can inspect
// the XML shape (e.g. confirm where categories live). Admin only.
router.get('/sanmar/debug-product', requireAdmin, async (req, res) => {
  const style = String(req.query.style || '').trim();
  if (!style) return res.status(400).json({ message: 'style query param required' });
  try {
    const config = loadSanmarConfig();
    const result = await getSanmarProduct(config, { productId: style });
    res.json({
      ok: true,
      style,
      extractedCategory: result.category,
      extractedCategories: result.categories,
      rawKeys: Object.keys(result._raw || {}),
      raw: result._raw,
    });
  } catch (e) {
    console.error('sanmar debug-product:', e);
    res.status(500).json({ ok: false, message: 'debug-product failed', detail: e.message });
  }
});

// ─── POST /api/suppliers/sanmar/reset-dr-flag ────────────────────────────────
// One-shot data repair: clear is_discontinued on rows that were flagged solely
// because their price_group is 'DR'. DR = "call for pricing", not end-of-life.
// Truly discontinued rows still have productName starting with "DISCONTINU" —
// those stay flagged.
router.post('/sanmar/reset-dr-flag', requireAdmin, async (req, res) => {
  try {
    const result = await query(
      `UPDATE supplier_product
          SET is_discontinued = FALSE
        WHERE supplier_id = (SELECT id FROM supplier WHERE code = 'sanmar_ca')
          AND is_discontinued = TRUE
          AND price_group = 'DR'
          AND (product_name IS NULL OR product_name NOT ILIKE 'DISCONTINU%')
        RETURNING id, style`,
    );
    res.json({ ok: true, cleared: result.length, styles: result.map((r) => r.style) });
  } catch (e) {
    console.error('sanmar reset-dr-flag:', e);
    res.status(500).json({ ok: false, message: 'reset-dr-flag failed', detail: e.message });
  }
});

// ─── GET /api/suppliers/sanmar/debug-style?style=ATC1000 ─────────────────────
// Diagnostic: is this style in our DB? what's its state? Admin only.
router.get('/sanmar/debug-style', requireAdmin, async (req, res) => {
  const style = String(req.query.style || '').trim();
  if (!style) return res.status(400).json({ message: 'style query param required' });
  try {
    // Exact + fuzzy (ATC1000 vs 1000 vs ATC1000P) case-insensitive lookup.
    const exact = await query(
      `SELECT p.id, p.style, p.brand, p.product_name, p.category, p.category_raw,
              p.is_sellable, p.is_discontinued, p.price_group, p.discount_code,
              p.last_synced_at,
              (SELECT COUNT(*) FROM supplier_variant v WHERE v.product_id = p.id)::int AS variant_count
         FROM supplier_product p
         JOIN supplier s ON s.id = p.supplier_id
        WHERE s.code = 'sanmar_ca' AND UPPER(p.style) = UPPER($1)`,
      [style],
    );
    const fuzzy = await query(
      `SELECT p.style, p.product_name, p.category, p.is_sellable, p.is_discontinued
         FROM supplier_product p
         JOIN supplier s ON s.id = p.supplier_id
        WHERE s.code = 'sanmar_ca' AND UPPER(p.style) LIKE UPPER($1)
        ORDER BY p.style
        LIMIT 30`,
      [`%${style}%`],
    );
    res.json({ ok: true, exact, fuzzy });
  } catch (e) {
    console.error('sanmar debug-style:', e);
    res.status(500).json({ ok: false, message: 'debug-style failed', detail: e.message });
  }
});

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

// ─── POST /api/suppliers/ss_activewear/ingest ────────────────────────────────
// Run the S&S Activewear Canada REST ingest. Synchronous. Optional query
// params scope the run to a single style for smoke testing — strongly
// recommended on the first run after schema or mapping changes:
//
//   ?styleID=12618        — direct integer styleID
//   ?style=A2009          — customer-facing style name; resolved via /V2/styles
//
// Without either, runs the full catalog (~1,121 styles / ~43k variants,
// 3 unfiltered API calls).
router.post('/ss_activewear/ingest', requireAdmin, async (req, res) => {
  const logs = [];
  try {
    const { runSsActivewearIngest } = require('../suppliers/ss_activewear/ingest');
    const { listStyles } = require('../suppliers/ss_activewear/client');

    let styleID = null;
    if (req.query.styleID) {
      styleID = parseInt(req.query.styleID, 10);
      if (!Number.isInteger(styleID)) {
        return res.status(400).json({ ok: false, message: 'styleID must be an integer' });
      }
    } else if (req.query.style) {
      // Resolve customer-facing style name → integer styleID via /V2/styles.
      const wanted = String(req.query.style).trim().toUpperCase();
      const all = await listStyles();
      const match = all.items.find((s) => (s.styleName || '').toUpperCase() === wanted);
      if (!match) {
        return res.status(404).json({
          ok: false,
          message: `style "${req.query.style}" not found in S&S catalog`,
        });
      }
      styleID = match.styleID;
      logs.push(`Resolved style=${req.query.style} to styleID=${styleID}`);
    }

    const result = await runSsActivewearIngest({ styleID, log: (m) => logs.push(m) });
    res.json({ ok: true, ...result, logs });
  } catch (e) {
    console.error('ss_activewear ingest:', e);
    res.status(500).json({
      ok: false,
      message: 'S&S Activewear ingest failed',
      detail: e.message,
      logs,
    });
  }
});

// ─── GET /api/suppliers/sanmar/debug-media?style=ATC1000 ─────────────────────
// Diagnostic: call getMediaContent for one style and return the parsed items
// plus the raw XML-shape payload so we can see exactly where colour hex / per-
// part image URLs live in SanMar's MediaContent response. Admin only.
router.get('/sanmar/debug-media', requireAdmin, async (req, res) => {
  const style = String(req.query.style || '').trim();
  if (!style) return res.status(400).json({ message: 'style query param required' });
  try {
    const config = loadSanmarConfig();
    const result = await getSanmarMedia(config, { productId: style });
    const byColor = {};
    for (const it of result.items) {
      if (!it.color) continue;
      const key = it.color;
      byColor[key] = byColor[key] || { hexes: new Set(), urls: new Set(), classTypes: new Set() };
      if (it.colorHex) byColor[key].hexes.add(it.colorHex);
      if (it.url)      byColor[key].urls.add(it.url);
      if (it.classType) byColor[key].classTypes.add(it.classType);
    }
    const colorSummary = Object.fromEntries(
      Object.entries(byColor).map(([k, v]) => [k, {
        hexes: [...v.hexes],
        mapHex: lookupSanmarHex(k),
        classTypes: [...v.classTypes],
        urlCount: v.urls.size,
      }])
    );
    res.json({
      ok: true,
      style,
      itemCount: result.items.length,
      colorSummary,
      sampleItems: result.items.slice(0, 8),
      messages: result.messages,
    });
  } catch (e) {
    console.error('sanmar debug-media:', e);
    res.status(500).json({ ok: false, message: 'debug-media failed', detail: e.message });
  }
});

// ─── POST /api/suppliers/sanmar/apply-color-hex ──────────────────────────────
// One-shot data repair: walk every distinct color_name in supplier_variant
// rows for SanMar, look it up in the hand-curated color-hex-map.js, and
// UPDATE matching rows. Lets us seed hex into existing catalog data without
// waiting for a full Bulk Data ingest.
//
// Query params:
//   ?refresh=1  → overwrite non-NULL color_hex values too (default: only
//                 touch rows where color_hex IS NULL)
//   ?dry-run=1  → compute counts, return them, write nothing
//   ?limit=N    → cap to the first N distinct colours (smoke test)
router.post('/sanmar/apply-color-hex', requireAdmin, async (req, res) => {
  const refresh = req.query.refresh === '1' || req.query.refresh === 'true';
  const dryRun  = req.query['dry-run'] === '1' || req.query['dry-run'] === 'true'
              || req.query.dryRun === '1' || req.query.dryRun === 'true';
  const limit   = req.query.limit ? Math.max(1, Number(req.query.limit)) : null;
  const logs    = [];
  const log     = (m) => logs.push(m);

  try {
    const { rows: colorRows } = await pool.query(
      `SELECT DISTINCT v.color_name
         FROM supplier_variant v
         JOIN supplier_product p ON p.id = v.product_id
         JOIN supplier s         ON s.id = p.supplier_id
        WHERE s.code = 'sanmar_ca'
          AND v.color_name IS NOT NULL
          ${refresh ? '' : 'AND v.color_hex IS NULL'}
        ORDER BY v.color_name
        ${limit ? `LIMIT ${Number(limit)}` : ''}`,
    );
    log(`apply-color-hex: ${colorRows.length} distinct colour names to process ` +
        `(refresh=${refresh}, dryRun=${dryRun})`);

    let resolved    = 0;
    let unmapped    = 0;
    let rowsUpdated = 0;
    const misses    = [];

    for (const { color_name: colorName } of colorRows) {
      const hex = lookupSanmarHex(colorName);
      if (!hex) {
        unmapped++;
        misses.push(colorName);
        continue;
      }
      resolved++;

      if (dryRun) {
        // Count how many rows would be affected, don't mutate.
        const { rows: cnt } = await pool.query(
          `SELECT COUNT(*)::int AS n
             FROM supplier_variant v
             JOIN supplier_product p ON p.id = v.product_id
             JOIN supplier s         ON s.id = p.supplier_id
            WHERE s.code = 'sanmar_ca'
              AND LOWER(v.color_name) = LOWER($1)
              ${refresh ? '' : 'AND v.color_hex IS NULL'}`,
          [colorName],
        );
        rowsUpdated += cnt[0].n;
      } else {
        const upd = await pool.query(
          `UPDATE supplier_variant
              SET color_hex = $1,
                  last_synced_at = NOW()
            WHERE id IN (
              SELECT v.id
                FROM supplier_variant v
                JOIN supplier_product p ON p.id = v.product_id
                JOIN supplier s         ON s.id = p.supplier_id
               WHERE s.code = 'sanmar_ca'
                 AND LOWER(v.color_name) = LOWER($2)
                 ${refresh ? '' : 'AND v.color_hex IS NULL'}
            )`,
          [hex, colorName],
        );
        rowsUpdated += upd.rowCount || 0;
      }
    }

    log(
      `apply-color-hex: done — resolved=${resolved}, unmapped=${unmapped}, ` +
      `rowsUpdated=${rowsUpdated}${dryRun ? ' (dry run)' : ''}`,
    );
    if (misses.length) {
      log(`apply-color-hex: missing from map: ${misses.slice(0, 40).join(', ')}` +
          (misses.length > 40 ? ` … and ${misses.length - 40} more` : ''));
    }

    res.json({
      ok: true,
      dryRun,
      refresh,
      distinctColours: colorRows.length,
      resolved,
      unmapped,
      rowsUpdated,
      misses,
      logs,
    });
  } catch (e) {
    console.error('sanmar apply-color-hex:', e);
    res.status(500).json({
      ok: false,
      message: 'apply-color-hex failed',
      detail: e.message,
      logs,
    });
  }
});

// ─── POST /api/suppliers/sanmar/media-backfill ───────────────────────────────
// One-shot trigger for the MediaContent backfill job. Same model as
// category-backfill: runs synchronously inside the API process (Railway), so
// bump your client timeout for a full run. Chunk with ?limit=N to stay under
// Railway's 5-minute HTTP edge timeout.
//
// Query params:
//   ?refresh=1      → re-sync every sellable style (default: only rows with
//                     NULL color_hex or NULL image_url)
//   ?limit=N        → cap to N styles (default: all qualifying)
//   ?rate=N         → ms between SOAP calls (default 400)
//   ?skip-images=1  → only touch color_hex, leave image_url alone
router.post('/sanmar/media-backfill', requireAdmin, async (req, res) => {
  const logs = [];
  const refresh    = req.query.refresh === '1' || req.query.refresh === 'true';
  const skipImages = req.query['skip-images'] === '1' || req.query['skip-images'] === 'true';
  const limit      = req.query.limit ? Number(req.query.limit) : null;
  const rateMs     = req.query.rate  ? Number(req.query.rate)  : undefined;
  try {
    const result = await backfillMedia({
      refresh,
      skipImages,
      limit,
      rateMs,
      log: (m) => logs.push(m),
    });
    res.json({ ok: true, ...result, logs });
  } catch (e) {
    console.error('sanmar media-backfill:', e);
    res.status(500).json({
      ok: false,
      message: 'SanMar media backfill failed',
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
