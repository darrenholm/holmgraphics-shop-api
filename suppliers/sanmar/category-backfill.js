// suppliers/sanmar/category-backfill.js
//
// One-time (and repeatable) category sync for SanMar Canada.
//
// The nightly Bulk Data ingest doesn't return categories — SanMar only
// exposes them via Product Data 2.0 GetProduct. This job fills the gap:
// iterate supplier_product rows, call GetProduct(productId=style), pull
// ProductCategoryArray[0].category, canonicalize, write it back.
//
// Resumable: by default only processes rows with category IS NULL.
// Pass --refresh to re-sync everything.
//
// CLI:
//   node suppliers/sanmar/category-backfill.js                 # incremental
//   node suppliers/sanmar/category-backfill.js --refresh       # all rows
//   node suppliers/sanmar/category-backfill.js --limit=50      # test run
//   node suppliers/sanmar/category-backfill.js --rate=500      # ms between calls
//
// Expected runtime for the full catalog at default rate:
//   669 styles × ~300 ms ≈ 3–4 min + network latency — plan for 5–15 min.

require('dotenv').config();

const { pool, query } = require('../../db/connection');
const { loadConfig } = require('./config');
const { getProduct } = require('../promostandards/product-data');
const { canonicalize } = require('./category-map');

const DEFAULT_RATE_MS = 300;
const RETRY_LIMIT     = 3;

async function backfillCategories({
  refresh = false,
  limit   = null,
  rateMs  = DEFAULT_RATE_MS,
  log     = console.log,
} = {}) {
  const config = loadConfig();

  // Select styles to process. Skip already-populated rows unless --refresh.
  const whereCategory = refresh ? '' : 'AND (p.category IS NULL OR p.category_raw IS NULL)';
  const limitSql = limit ? `LIMIT ${Number(limit)}` : '';
  const styles = await query(
    `SELECT p.id, p.style
       FROM supplier_product p
       JOIN supplier s ON s.id = p.supplier_id
      WHERE s.code = 'sanmar_ca'
        AND p.is_sellable = TRUE
        ${whereCategory}
      ORDER BY p.style
      ${limitSql}`
  );
  log(`category-backfill: ${styles.length} styles to process${refresh ? ' (full refresh)' : ''} at ${rateMs}ms/call`);
  if (styles.length === 0) {
    log('category-backfill: nothing to do');
    return { ok: 0, failed: 0, skipped: 0 };
  }

  // Open the audit row so we can see when this ran from the DB.
  const supplierRow = (await pool.query(
    `SELECT id FROM supplier WHERE code = 'sanmar_ca' LIMIT 1`
  )).rows[0];
  const { rows: runRows } = await pool.query(
    `INSERT INTO sync_run (supplier_id, kind, status)
     VALUES ($1, 'product_data', 'running') RETURNING id`,
    [supplierRow.id]
  );
  const syncId = runRows[0].id;
  log(`category-backfill: sync_run #${syncId} opened`);

  let ok = 0, failed = 0;

  try {
    for (let i = 0; i < styles.length; i++) {
      const row = styles[i];
      try {
        const result = await withRetry(
          () => getProduct(config, { productId: row.style }),
          RETRY_LIMIT,
        );
        const raw = result.category || null;
        const canon = canonicalize(raw);
        await pool.query(
          `UPDATE supplier_product
              SET category     = $1,
                  category_raw = $2
            WHERE id = $3`,
          [canon, raw, row.id],
        );
        ok++;
        // Log every style early (to catch auth/perm failures fast) then
        // throttle to every 10th so the output stays readable.
        if (i < 5 || i % 10 === 0) {
          log(`  [${i + 1}/${styles.length}] ${row.style} → ${canon} (raw: ${raw || '—'})`);
        }
      } catch (e) {
        failed++;
        log(`  [${i + 1}/${styles.length}] ${row.style} FAILED — ${e.message}`);
      }
      if (i + 1 < styles.length) await sleep(rateMs);
    }

    const status = failed === 0 ? 'success' : 'failed';
    await pool.query(
      `UPDATE sync_run
          SET status = $1,
              ended_at = NOW(),
              products_upserted = $2,
              error_message = $3
        WHERE id = $4`,
      [status, ok, failed > 0 ? `${failed} styles failed; see logs` : null, syncId],
    );

    log(`category-backfill: done — ok=${ok} failed=${failed}`);
    return { ok, failed, syncId };
  } catch (e) {
    await pool.query(
      `UPDATE sync_run
          SET status = 'failed',
              ended_at = NOW(),
              products_upserted = $1,
              error_message = $2
        WHERE id = $3`,
      [ok, e.message, syncId],
    );
    log(`category-backfill: ABORTED — ${e.message}`);
    throw e;
  }
}

// ── utils ───────────────────────────────────────────────────────────────

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function withRetry(fn, tries) {
  let lastErr;
  for (let i = 0; i < tries; i++) {
    try {
      return await fn();
    } catch (e) {
      lastErr = e;
      // Exponential-ish backoff: 500 / 1000 / 1500ms.
      await sleep(500 * (i + 1));
    }
  }
  throw lastErr;
}

module.exports = { backfillCategories };

// ── CLI entry point ─────────────────────────────────────────────────────

if (require.main === module) {
  const argv = process.argv.slice(2);
  const flag = (name) => argv.includes(`--${name}`);
  const kv = (name) => {
    const hit = argv.find((a) => a.startsWith(`--${name}=`));
    return hit ? hit.split('=')[1] : null;
  };
  const limit  = kv('limit')  ? Number(kv('limit'))  : null;
  const rateMs = kv('rate')   ? Number(kv('rate'))   : DEFAULT_RATE_MS;

  backfillCategories({ refresh: flag('refresh'), limit, rateMs })
    .then(() => pool.end())
    .catch((e) => {
      console.error(e.stack || e.message);
      pool.end();
      process.exit(1);
    });
}
