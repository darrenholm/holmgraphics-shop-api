// suppliers/ss_activewear/category-backfill.js
//
// One-time (and repeatable) category sync for S&S Activewear Canada.
//
// Unlike SanMar, S&S serves baseCategory directly on /V2/styles, so the
// regular ingest already has the data — but rows ingested before the
// ingester started writing the category column have NULL category.
// Rather than re-ingest the catalog (3 API calls + ~1100 transactions),
// this backfill reads the baseCategory from each row's raw_json and
// canonicalises it, writing back category + category_raw. Zero S&S API
// calls.
//
// Resumable: by default only processes rows with category IS NULL.
// Pass --refresh to re-canonicalise everything (e.g. after extending
// the regex rules in suppliers/sanmar/category-map.js).
//
// CLI:
//   node suppliers/ss_activewear/category-backfill.js              # incremental
//   node suppliers/ss_activewear/category-backfill.js --refresh    # all rows
//   node suppliers/ss_activewear/category-backfill.js --limit=20   # test run
//
// Mirrors suppliers/sanmar/category-backfill.js's CLI flags so muscle
// memory carries across suppliers.

'use strict';

require('dotenv').config();

const { pool, query } = require('../../db/connection');
const { canonicalize } = require('../sanmar/category-map');

async function backfillCategories({
  refresh = false,
  limit   = null,
  log     = console.log,
} = {}) {
  const whereClause = refresh ? '' : 'AND p.category IS NULL';
  const limitSql    = limit ? `LIMIT ${Number(limit)}` : '';

  const styles = await query(
    `SELECT p.id, p.style, p.raw_json
       FROM supplier_product p
       JOIN supplier s ON s.id = p.supplier_id
      WHERE s.code = 'ss_activewear_ca'
        ${whereClause}
      ORDER BY p.id
      ${limitSql}`
  );
  log(`ss_activewear category-backfill: ${styles.length} rows to process${refresh ? ' (full refresh)' : ''}`);
  if (styles.length === 0) {
    log('ss_activewear category-backfill: nothing to do');
    return { ok: 0, skipped: 0 };
  }

  // Audit row.
  const supplierRow = (await pool.query(
    `SELECT id FROM supplier WHERE code = 'ss_activewear_ca' LIMIT 1`
  )).rows[0];
  if (!supplierRow) {
    throw new Error("supplier 'ss_activewear_ca' not found — run migration 011 first");
  }
  const { rows: runRows } = await pool.query(
    `INSERT INTO sync_run (supplier_id, kind, status)
     VALUES ($1, 'product_data', 'running') RETURNING id`,
    [supplierRow.id]
  );
  const syncId = runRows[0].id;
  log(`ss_activewear category-backfill: sync_run #${syncId} opened`);

  // Bucket counters for the summary line.
  const buckets = new Map();
  let ok = 0, skipped = 0;

  try {
    // Single transaction — backfill is read-mostly and we want all-or-nothing
    // semantics if something goes wrong mid-loop.
    const dbClient = await pool.connect();
    try {
      await dbClient.query('BEGIN');
      for (const row of styles) {
        const rawJson = typeof row.raw_json === 'string'
          ? JSON.parse(row.raw_json)
          : row.raw_json;
        const raw = rawJson?.baseCategory || null;
        if (raw === null) {
          // No baseCategory captured at ingest time — write 'other' so the
          // row at least has a non-NULL bucket and shows up in the UI's
          // catch-all tab. Logged so we know how many fell here.
          skipped++;
        }
        const canon = canonicalize(raw);
        await dbClient.query(
          `UPDATE supplier_product
              SET category     = $1,
                  category_raw = $2
            WHERE id = $3`,
          [canon, raw, row.id],
        );
        ok++;
        buckets.set(canon, (buckets.get(canon) || 0) + 1);
      }
      await dbClient.query('COMMIT');
    } catch (txErr) {
      await dbClient.query('ROLLBACK');
      throw txErr;
    } finally {
      dbClient.release();
    }

    await pool.query(
      `UPDATE sync_run
          SET status='success',
              ended_at=NOW(),
              products_upserted=$2
        WHERE id=$1`,
      [syncId, ok],
    );

    log(`ss_activewear category-backfill: DONE — ${ok} updated (${skipped} had no baseCategory)`);
    log('bucket totals:');
    for (const [cat, n] of [...buckets.entries()].sort((a, b) => b[1] - a[1])) {
      log(`  ${cat.padEnd(14)}  ${n}`);
    }
    return { syncId, ok, skipped, buckets: Object.fromEntries(buckets) };
  } catch (err) {
    await pool.query(
      `UPDATE sync_run
          SET status='failed',
              ended_at=NOW(),
              products_upserted=$2,
              error_message=$3
        WHERE id=$1`,
      [syncId, ok, err.message],
    );
    throw err;
  }
}

module.exports = { backfillCategories };

if (require.main === module) {
  const argv = process.argv.slice(2);
  const flag = (name) => argv.includes(`--${name}`);
  const kv = (name) => {
    const hit = argv.find((a) => a.startsWith(`--${name}=`));
    return hit ? hit.split('=')[1] : null;
  };
  const limit = kv('limit') ? Number(kv('limit')) : null;

  backfillCategories({ refresh: flag('refresh'), limit })
    .then(() => pool.end())
    .catch((e) => {
      console.error(e.stack || e.message);
      pool.end();
      process.exit(1);
    });
}
