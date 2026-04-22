// suppliers/sanmar/media-backfill.js
//
// Per-colour metadata sync for SanMar Canada.
//
// Bulk Data 1.0 gives us price + stock but only a single `imageUrl` string
// per variant, and Media Content 1.2 — the cleanest per-image response we
// can get — still has NO hex field in its schema. This job therefore:
//
//   image_url  ← MediaContent 1.2 Primary images when the variant row is
//                missing imagery (e.g. ATC1000 family — SanMar doesn't ship
//                Bulk Data images for DR products)
//
//   color_hex  ← Hand-curated color-hex-map.js. We once also scraped hex
//                from MediaContent items that had it, but v1.2 doesn't
//                standardise hex at all; the map is the source of truth.
//                Any hex a MediaContent response does happen to contain is
//                still honoured (some suppliers ship a custom extension),
//                the map is the fallback.
//
// Strategy mirrors category-backfill.js:
//   - Resumable (only touches rows missing what we'd backfill unless --refresh)
//   - Rate-limited, per-call retry, writes a sync_run audit row
//   - Incremental chunks via --limit / ?limit so the Railway edge HTTP
//     timeout (5 min) doesn't kill a full catalog run
//
// CLI:
//   node suppliers/sanmar/media-backfill.js                 # incremental
//   node suppliers/sanmar/media-backfill.js --refresh       # re-hit every row
//   node suppliers/sanmar/media-backfill.js --limit=50      # smoke test
//   node suppliers/sanmar/media-backfill.js --rate=500      # ms between calls
//   node suppliers/sanmar/media-backfill.js --skip-images   # hex only

require('dotenv').config();

const { pool, query } = require('../../db/connection');
const { loadConfig } = require('./config');
const { getMediaContent } = require('../promostandards/media-content');
const { lookupHex } = require('./color-hex-map');

const DEFAULT_RATE_MS = 400;
const RETRY_LIMIT     = 3;

async function backfillMedia({
  refresh     = false,
  limit       = null,
  rateMs      = DEFAULT_RATE_MS,
  skipImages  = false,
  log         = console.log,
} = {}) {
  const config = loadConfig();

  // Select styles to process. Default: styles with at least one variant
  // missing color_hex (and optionally image_url). --refresh: every sellable
  // style.
  const gapClause = refresh
    ? ''
    : `AND EXISTS (
         SELECT 1 FROM supplier_variant v
          WHERE v.product_id = p.id
            AND (
              v.color_hex IS NULL
              ${skipImages ? '' : 'OR v.image_url IS NULL'}
            )
       )`;
  const limitSql = limit ? `LIMIT ${Number(limit)}` : '';

  const styles = await query(
    `SELECT p.id, p.style
       FROM supplier_product p
       JOIN supplier s ON s.id = p.supplier_id
      WHERE s.code = 'sanmar_ca'
        AND p.is_sellable = TRUE
        AND p.is_discontinued = FALSE
        ${gapClause}
      ORDER BY p.style
      ${limitSql}`
  );
  log(
    `media-backfill: ${styles.length} styles to process` +
    `${refresh ? ' (full refresh)' : ''}` +
    `${skipImages ? ' [hex only]' : ''}` +
    ` at ${rateMs}ms/call`
  );
  if (styles.length === 0) {
    log('media-backfill: nothing to do');
    return { ok: 0, failed: 0, hexUpdated: 0, imageUpdated: 0, skipped: 0 };
  }

  // Open the audit row so admins can see when this ran / what it touched.
  const supplierRow = (await pool.query(
    `SELECT id FROM supplier WHERE code = 'sanmar_ca' LIMIT 1`
  )).rows[0];
  const { rows: runRows } = await pool.query(
    `INSERT INTO sync_run (supplier_id, kind, status)
     VALUES ($1, 'media_content', 'running') RETURNING id`,
    [supplierRow.id]
  );
  const syncId = runRows[0].id;
  log(`media-backfill: sync_run #${syncId} opened`);

  let ok = 0, failed = 0;
  let hexUpdated = 0, imageUpdated = 0;

  try {
    for (let i = 0; i < styles.length; i++) {
      const row = styles[i];
      try {
        const result = await withRetry(
          () => getMediaContent(config, { productId: row.style }),
          RETRY_LIMIT,
        );

        // Build maps off the response.
        //   hexByColor[colorName.toLowerCase()]  → '#RRGGBB'
        //   primaryImageByPart[partId]           → primary image URL
        //   primaryImageByColor[colorName.toLowerCase()] → primary image URL
        const hexByColor         = new Map();
        const primaryImageByPart = new Map();
        const primaryImageByColor = new Map();

        for (const item of result.items || []) {
          const colorKey = item.color ? item.color.toLowerCase() : null;

          if (item.colorHex && colorKey && !hexByColor.has(colorKey)) {
            hexByColor.set(colorKey, item.colorHex);
          }

          // v1.2 puts the file kind on `fileType`; our parser normalises it
          // to `mediaType`. Be tolerant of null (some adapters omit it when
          // the URL is obviously an image).
          const isImage = !item.mediaType || /image/i.test(item.mediaType);
          if (
            !skipImages &&
            item.url &&
            isImage &&
            (item.classType === 'Primary' || item.classType === null)
          ) {
            for (const pid of (item.partIds || [])) {
              if (!primaryImageByPart.has(pid)) primaryImageByPart.set(pid, item.url);
            }
            if (colorKey && !primaryImageByColor.has(colorKey)) {
              primaryImageByColor.set(colorKey, item.url);
            }
          }
        }

        // Fallback: hand-curated map covers colours MediaContent didn't
        // give us hex for. Look at the colour names actually present on
        // this product's variants.
        const { rows: variantColors } = await pool.query(
          `SELECT DISTINCT color_name
             FROM supplier_variant
            WHERE product_id = $1
              AND color_name IS NOT NULL`,
          [row.id],
        );
        for (const r of variantColors) {
          const colorKey = r.color_name.toLowerCase();
          if (!hexByColor.has(colorKey)) {
            const mapHex = lookupHex(r.color_name);
            if (mapHex) hexByColor.set(colorKey, mapHex);
          }
        }

        // Apply: update supplier_variant rows for this product.
        let hexWrites = 0, imageWrites = 0;

        // color_hex: set where currently NULL (or always if refresh) and a
        // hex is known for that colorName.
        if (hexByColor.size > 0) {
          for (const [colorKey, hex] of hexByColor) {
            const res = await pool.query(
              `UPDATE supplier_variant
                  SET color_hex = $1,
                      last_synced_at = NOW()
                WHERE product_id = $2
                  AND LOWER(color_name) = $3
                  ${refresh ? '' : 'AND color_hex IS NULL'}`,
              [hex, row.id, colorKey],
            );
            hexWrites += res.rowCount || 0;
          }
        }

        // image_url: per-part first; fall back to per-color for anything
        // still missing.
        if (!skipImages) {
          if (primaryImageByPart.size > 0) {
            for (const [pid, url] of primaryImageByPart) {
              const res = await pool.query(
                `UPDATE supplier_variant
                    SET image_url = $1,
                        last_synced_at = NOW()
                  WHERE product_id = $2
                    AND supplier_variant_id = $3
                    ${refresh ? '' : 'AND image_url IS NULL'}`,
                [url, row.id, pid],
              );
              imageWrites += res.rowCount || 0;
            }
          }
          if (primaryImageByColor.size > 0) {
            for (const [colorKey, url] of primaryImageByColor) {
              const res = await pool.query(
                `UPDATE supplier_variant
                    SET image_url = $1,
                        last_synced_at = NOW()
                  WHERE product_id = $2
                    AND LOWER(color_name) = $3
                    AND image_url IS NULL`,
                [url, row.id, colorKey],
              );
              imageWrites += res.rowCount || 0;
            }
          }
        }

        hexUpdated   += hexWrites;
        imageUpdated += imageWrites;
        ok++;

        // First few always, then every 10th for signal without noise.
        if (i < 5 || i % 10 === 0) {
          log(
            `  [${i + 1}/${styles.length}] ${row.style} → ` +
            `hex:${hexByColor.size} img:${primaryImageByPart.size + primaryImageByColor.size} ` +
            `(wrote ${hexWrites} hex, ${imageWrites} img)`
          );
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
              variants_upserted = $3,
              error_message = $4
        WHERE id = $5`,
      [
        status,
        ok,
        hexUpdated + imageUpdated,
        failed > 0 ? `${failed} styles failed; see logs` : null,
        syncId,
      ],
    );

    log(
      `media-backfill: done — ok=${ok} failed=${failed} ` +
      `hexUpdated=${hexUpdated} imageUpdated=${imageUpdated}`
    );
    return { ok, failed, hexUpdated, imageUpdated, syncId };
  } catch (e) {
    await pool.query(
      `UPDATE sync_run
          SET status = 'failed',
              ended_at = NOW(),
              products_upserted = $1,
              variants_upserted = $2,
              error_message = $3
        WHERE id = $4`,
      [ok, hexUpdated + imageUpdated, e.message, syncId],
    );
    log(`media-backfill: ABORTED — ${e.message}`);
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
      await sleep(500 * (i + 1));
    }
  }
  throw lastErr;
}

module.exports = { backfillMedia };

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

  backfillMedia({
    refresh:    flag('refresh'),
    skipImages: flag('skip-images'),
    limit,
    rateMs,
  })
    .then(() => pool.end())
    .catch((e) => {
      console.error(e.stack || e.message);
      pool.end();
      process.exit(1);
    });
}
