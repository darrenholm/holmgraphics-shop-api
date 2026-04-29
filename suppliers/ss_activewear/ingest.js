// suppliers/ss_activewear/ingest.js
//
// S&S Activewear Canada catalog ingest. Mirrors the SanMar pattern in
// suppliers/sanmar/ingest.js but pulls from S&S's REST V2 API instead of
// SanMar Bulk Data SOAP.
//
// Strategy:
//   1. /V2/styles      — one call, every parent style.
//   2. /V2/products    — one call, every variant (sku, sizes, colors with
//                        native hex, prices, image paths).
//   3. /V2/inventory   — one call, per-warehouse quantities per sku.
//   4. Group products + inventory by styleID, upsert one supplier_product
//      per style and N supplier_variants per style.
//   5. Record the run in sync_run.
//
// Three unfiltered API calls cover the whole 1,121-style / ~43k-variant
// catalog. Per-style (smoke-test) mode passes ?styleID=N to all three
// endpoints — same code path, just smaller responses.
//
// Idempotent: ON CONFLICT DO UPDATE everywhere. color_hex preservation
// matches SanMar: COALESCE(EXCLUDED.color_hex, supplier_variant.color_hex)
// keeps any manual override but S&S serves real hex on every variant via
// `color1`, so the COALESCE rarely matters here. Kept for symmetry.
//
// CLI usage (full catalog):
//   node suppliers/ss_activewear/ingest.js
//
// CLI usage (one style for smoke test):
//   node suppliers/ss_activewear/ingest.js --styleID=12618
//   node suppliers/ss_activewear/ingest.js --style=A2009
//
// Programmatic:
//   const { runSsActivewearIngest } = require('./suppliers/ss_activewear/ingest');
//   await runSsActivewearIngest({ styleID: 12618 });

'use strict';

require('dotenv').config();

const { pool, query, queryOne } = require('../../db/connection');
const { listStyles, listProducts, listInventory } = require('./client');
const { IMAGE_BASE_URL } = require('./config');

// Size sort order — duplicates the table in suppliers/sanmar/ingest.js.
// Worth a small shared module if we add a third supplier; keeping inline
// for now keeps the diff for adding a supplier scoped to one folder.
const SIZE_ORDER = {
  'XXS': 5,  'XS': 10,  'S': 20,  'M': 30,  'L': 40,  'XL': 50,
  '2XL': 60, 'XXL': 60,
  '3XL': 70, 'XXXL': 70,
  '4XL': 80, 'XXXXL': 80,
  '5XL': 90, '6XL': 100, '7XL': 110,
  'YXS': 510, 'YS': 520, 'YM': 530, 'YL': 540, 'YXL': 550,
  'OSFA': 900, 'OS': 900, 'ONE SIZE': 900,
};

function sizeSortKey(size) {
  if (!size) return 999;
  const upper = String(size).trim().toUpperCase();
  return SIZE_ORDER[upper] ?? 999;
}

// Build an absolute image URL from a variant's relative path. S&S returns
// '' for missing images — pass that through as null so the schema stays
// honest.
function absImage(relPath) {
  if (!relPath) return null;
  // Already absolute? Unlikely but defensive.
  if (/^https?:\/\//i.test(relPath)) return relPath;
  return `${IMAGE_BASE_URL}/${relPath.replace(/^\/+/, '')}`;
}

// Sum warehouse qty across all warehouses for a given sku. Inventory rows
// may have a top-level `qty` too (we saw both shapes in probing); prefer
// the warehouse sum since it's authoritative.
function totalQty(inv) {
  if (!inv) return null;
  if (Array.isArray(inv.warehouses) && inv.warehouses.length) {
    return inv.warehouses.reduce((sum, w) => sum + (Number(w.qty) || 0), 0);
  }
  if (Number.isFinite(Number(inv.qty))) return Number(inv.qty);
  return null;
}

// ── DB upserts ──────────────────────────────────────────────────────────

async function upsertProduct(client, supplierId, style, products) {
  // S&S returns identical brand/styleName/title across every variant of a
  // given style — pick the first to populate the parent row. raw_json
  // carries the rest (categories list, etc.) for future enrichment.
  const sample = products[0];
  const productName = sample.title || sample.styleName || null;
  const brand       = sample.brandName || null;
  const description = sample.description || null;
  const caseSize    = Number(sample.caseQty) || null;

  const rawJson = {
    styleID:        sample.styleID,
    styleName:      sample.styleName,
    partNumber:     sample.partNumber || null,
    baseCategory:   sample.baseCategory || null,
    baseCategoryID: sample.baseCategoryID || null,
    brandID:        sample.brandID || null,
    variantCount:   products.length,
  };

  const { rows } = await client.query(
    `
    INSERT INTO supplier_product (
      supplier_id, style,
      product_name, fr_product_name,
      description, fr_description,
      brand, discount_code, price_group,
      youth, case_size,
      is_sellable, is_discontinued,
      raw_json, last_synced_at
    )
    VALUES ($1, $2, $3, NULL, $4, NULL, $5, NULL, NULL, FALSE, $6, TRUE, FALSE, $7::jsonb, NOW())
    ON CONFLICT (supplier_id, style) DO UPDATE SET
      product_name     = EXCLUDED.product_name,
      description      = EXCLUDED.description,
      brand            = EXCLUDED.brand,
      case_size        = EXCLUDED.case_size,
      raw_json         = EXCLUDED.raw_json,
      last_synced_at   = NOW()
    RETURNING id
    `,
    [supplierId, style, productName, description, brand, caseSize, JSON.stringify(rawJson)],
  );
  return rows[0].id;
}

async function upsertVariant(client, productId, p, qty) {
  // S&S serves native hex via color1 (and color2 for two-tone). Always
  // present on every variant, includes leading '#'. Two-tone styles get
  // color2 stashed in raw_json so the UI can render a striped swatch later.
  const colorHex = p.color1 || null;
  const imageUrl = absImage(p.colorFrontImage);

  const rawJson = {
    skuID_Master:      p.skuID_Master,
    colorCode:         p.colorCode,
    colorGroup:        p.colorGroup,
    colorGroupName:    p.colorGroupName,
    colorFamily:       p.colorFamily,
    color2:            p.color2 || null,
    sizeCode:          p.sizeCode,
    colorSwatchImage:  absImage(p.colorSwatchImage),
    colorBackImage:    absImage(p.colorBackImage),
    colorOnModelFront: absImage(p.colorOnModelFrontImage),
    mapPrice:          p.mapPrice,
    retailPrice:       p.retailPrice,
    dozenPrice:        p.dozenPrice,
    casePrice:         p.casePrice,
    countryOfOrigin:   p.countryOfOrigin || null,
  };

  await client.query(
    `
    INSERT INTO supplier_variant (
      product_id, supplier_variant_id,
      size, size_order,
      color_name, fr_color_name, color_hex,
      weight_lb, image_url, gtin,
      quantity, price, sale_price, sale_end_date, currency,
      raw_json, last_synced_at
    )
    VALUES ($1, $2, $3, $4, $5, NULL, $6, $7, $8, $9, $10, $11, NULL, NULL, 'CAD', $12::jsonb, NOW())
    ON CONFLICT (product_id, supplier_variant_id) DO UPDATE SET
      size            = EXCLUDED.size,
      size_order      = EXCLUDED.size_order,
      color_name      = EXCLUDED.color_name,
      color_hex       = COALESCE(EXCLUDED.color_hex, supplier_variant.color_hex),
      weight_lb       = EXCLUDED.weight_lb,
      image_url       = EXCLUDED.image_url,
      gtin            = EXCLUDED.gtin,
      quantity        = EXCLUDED.quantity,
      price           = EXCLUDED.price,
      raw_json        = EXCLUDED.raw_json,
      last_synced_at  = NOW()
    `,
    [
      productId, p.sku,
      p.sizeName, sizeSortKey(p.sizeName),
      p.colorName, colorHex,
      Number(p.unitWeight) || null,
      imageUrl,
      p.gtin || null,
      qty,
      Number(p.piecePrice) || null,
      JSON.stringify(rawJson),
    ],
  );
}

// ── Main entrypoint ─────────────────────────────────────────────────────

async function runSsActivewearIngest({ styleID = null, log = console.log } = {}) {
  const supplier = await queryOne(
    `SELECT id FROM supplier WHERE code = 'ss_activewear_ca' LIMIT 1`,
  );
  if (!supplier) {
    throw new Error(
      "supplier 'ss_activewear_ca' not found — run migration 011_ss_activewear_supplier first",
    );
  }
  const supplierId = supplier.id;

  // Open the audit row first so even an early failure leaves a trace.
  const { rows: syncRows } = await pool.query(
    `INSERT INTO sync_run (supplier_id, kind, status)
     VALUES ($1, 'bulk_data', 'running') RETURNING id`,
    [supplierId],
  );
  const syncId = syncRows[0].id;
  log(`ss_activewear ingest: sync_run #${syncId} opened${styleID ? ` (single styleID=${styleID})` : ' (full catalog)'}`);

  let productsUpserted = 0;
  let variantsUpserted = 0;

  try {
    // Three calls, in parallel — they don't depend on each other's data,
    // and the rate limit is per-second-window, not per-concurrent-request.
    log('ss_activewear ingest: fetching /V2/styles + /V2/products + /V2/inventory…');
    const [styles, products, inventory] = await Promise.all([
      listStyles({ styleID }),
      listProducts({ styleID }),
      listInventory({ styleID }),
    ]);
    log(`ss_activewear ingest: ${styles.items.length} styles, ${products.items.length} products, ${inventory.items.length} inventory rows`);
    log(`ss_activewear ingest: rate limit remaining (last call) = ${inventory.rateRemaining}`);

    // Group products by styleID. Index inventory by sku for O(1) lookup.
    const productsByStyle = new Map();
    for (const p of products.items) {
      const sid = p.styleID;
      if (!sid) continue;
      if (!productsByStyle.has(sid)) productsByStyle.set(sid, []);
      productsByStyle.get(sid).push(p);
    }

    const invBySku = new Map();
    for (const inv of inventory.items) {
      if (inv.sku) invBySku.set(inv.sku, inv);
    }

    // Build a styleID → styleName map so each style's parent row uses the
    // styleName (customer-facing, e.g. "A2009") as `style`. Falls back to
    // the styleID stringified — should never happen for active rows.
    const styleNameById = new Map();
    for (const s of styles.items) {
      if (s.styleID && s.styleName) styleNameById.set(s.styleID, s.styleName);
    }

    // One transaction per style keeps failure blast radius small (a single
    // bad style's variants don't take the rest of the run down).
    for (const [sid, group] of productsByStyle) {
      const styleName = styleNameById.get(sid) || String(sid);
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        // Merge style-level metadata (description, baseCategory, etc.) into
        // each product so upsertProduct's "first wins" picks them up. The
        // /V2/products payload doesn't carry style-level fields like
        // `title` or `description` — those live on /V2/styles.
        const styleRow = styles.items.find((s) => s.styleID === sid) || {};
        const enrichedGroup = group.map((p) => ({
          ...p,
          title:        styleRow.title || null,
          description:  styleRow.description || null,
          baseCategory: styleRow.baseCategory || null,
          partNumber:   styleRow.partNumber || null,
        }));
        const productId = await upsertProduct(client, supplierId, styleName, enrichedGroup);
        productsUpserted++;
        for (const p of enrichedGroup) {
          const inv = invBySku.get(p.sku);
          await upsertVariant(client, productId, p, totalQty(inv));
          variantsUpserted++;
        }
        await client.query('COMMIT');
      } catch (err) {
        await client.query('ROLLBACK');
        log(`ss_activewear ingest: style ${styleName} FAILED — ${err.message}`);
        // Don't re-throw — keep going with the rest of the catalog. The
        // sync_run audit row captures the count discrepancy if it matters.
      } finally {
        client.release();
      }
    }

    await pool.query(
      `UPDATE sync_run
          SET status='success',
              ended_at=NOW(),
              products_upserted=$2,
              variants_upserted=$3
        WHERE id=$1`,
      [syncId, productsUpserted, variantsUpserted],
    );
    log(`ss_activewear ingest: DONE — ${productsUpserted} products, ${variantsUpserted} variants`);
    return { syncId, productsUpserted, variantsUpserted };
  } catch (err) {
    await pool.query(
      `UPDATE sync_run
          SET status='failed',
              ended_at=NOW(),
              products_upserted=$2,
              variants_upserted=$3,
              error_message=$4,
              error_detail=$5::jsonb
        WHERE id=$1`,
      [
        syncId,
        productsUpserted,
        variantsUpserted,
        err.message,
        JSON.stringify({
          status: err.status || null,
          body:   err.body   || null,
          url:    err.url    || null,
        }),
      ],
    );
    throw err;
  }
}

// ── CLI ─────────────────────────────────────────────────────────────────

if (require.main === module) {
  // Parse --styleID=N or --style=NAME
  const args = process.argv.slice(2);
  let styleID = null;
  for (const a of args) {
    const m = a.match(/^--styleID=(\d+)$/i);
    if (m) styleID = parseInt(m[1], 10);
  }
  // --style=NAME requires a styleID lookup; resolve via /V2/styles.
  const styleNameArg = args.find((a) => /^--style=/.test(a))?.slice('--style='.length);

  (async () => {
    try {
      if (styleNameArg && !styleID) {
        const all = await listStyles();
        const match = all.items.find((s) => (s.styleName || '').toUpperCase() === styleNameArg.toUpperCase());
        if (!match) throw new Error(`style "${styleNameArg}" not found in S&S catalog`);
        styleID = match.styleID;
        console.log(`Resolved --style=${styleNameArg} to styleID=${styleID}`);
      }
      const result = await runSsActivewearIngest({ styleID });
      console.log(JSON.stringify(result, null, 2));
      process.exit(0);
    } catch (err) {
      console.error('ss_activewear ingest FAILED:', err.message);
      if (err.body) console.error('  body:', JSON.stringify(err.body).slice(0, 500));
      process.exit(1);
    }
  })();
}

module.exports = { runSsActivewearIngest };
