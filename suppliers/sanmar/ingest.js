// suppliers/sanmar/ingest.js
//
// Nightly SanMar Canada catalog ingest from the Bulk Data service.
//
// Strategy:
//   1. Call GetBulkData — one request, whole catalog.
//   2. Group the flat variant list by `style` to derive parent products.
//   3. Upsert supplier_product rows (one per style).
//   4. Upsert supplier_variant rows (one per productId).
//   5. Record the run in sync_run.
//
// Idempotent: ON CONFLICT DO UPDATE everywhere. Re-running the same night
// just refreshes last_synced_at + mutates changed fields.
//
// CLI usage (runs a full sync against SANMAR_ENV):
//   node suppliers/sanmar/ingest.js
//
// Programmatic usage:
//   const { runSanmarIngest } = require('./suppliers/sanmar/ingest');
//   await runSanmarIngest();

require('dotenv').config();

const { pool, query, queryOne } = require('../../db/connection');
const sanmar = require('./index');

// ── size → sort order map so variants display S < M < L < XL consistently ─
const SIZE_ORDER = {
  'XXS': 5,  'XS': 10,  'S': 20,  'M': 30,  'L': 40,  'XL': 50,
  '2XL': 60, 'XXL': 60,
  '3XL': 70, 'XXXL': 70,
  '4XL': 80, 'XXXXL': 80,
  '5XL': 90, '6XL': 100, '7XL': 110,
  // youth
  'YXS': 510, 'YS': 520, 'YM': 530, 'YL': 540, 'YXL': 550,
  // one-size
  'OSFA': 900, 'OS': 900, 'ONE SIZE': 900,
};

function sizeSortKey(size) {
  if (!size) return 999;
  const upper = String(size).trim().toUpperCase();
  return SIZE_ORDER[upper] ?? 999;
}

// Is this variant a discontinued row?
//
// Historical note: we previously treated priceGroup === 'DR' as a discontinued
// signal. That was wrong — DR means "call for pricing" (pricing hidden at the
// wholesale level, e.g. staple SKUs like ATC1000). Those products are still
// actively sold. The only reliable discontinued signal in Bulk Data is the
// productName prefix.
function looksDiscontinued(v) {
  if (v.productName && /^\s*DISCONTINU/i.test(v.productName)) return true;
  return false;
}

// Group flat variant rows by style.
function groupByStyle(variants) {
  const groups = new Map();
  for (const v of variants) {
    if (!v.style) continue;
    if (!groups.has(v.style)) groups.set(v.style, []);
    groups.get(v.style).push(v);
  }
  return groups;
}

// Pick a non-null value from a group of variants (first wins).
function firstNonNull(arr, key) {
  for (const v of arr) if (v[key] !== null && v[key] !== undefined) return v[key];
  return null;
}

// Majority (or first) value across a group.
function groupConsensus(arr, key) {
  const counts = new Map();
  for (const v of arr) {
    const val = v[key];
    if (val === null || val === undefined) continue;
    counts.set(val, (counts.get(val) || 0) + 1);
  }
  if (counts.size === 0) return null;
  return [...counts.entries()].sort((a, b) => b[1] - a[1])[0][0];
}

// ── DB upserts ──────────────────────────────────────────────────────────

async function upsertProduct(client, supplierId, style, group) {
  const rep = group[0];  // representative row for style-level fields
  const brand        = firstNonNull(group, 'brand');
  const productName  = firstNonNull(group, 'productName');
  const frProductName = firstNonNull(group, 'frProductName');
  const description  = firstNonNull(group, 'description');
  const frDescription = firstNonNull(group, 'frDescription');
  const discountCode = firstNonNull(group, 'discountCode');
  const priceGroup   = groupConsensus(group, 'priceGroup');
  const youth        = group.some((v) => v.youth === true);
  const caseSize     = firstNonNull(group, 'caseSize');
  const anyDisc      = group.some(looksDiscontinued);

  const rawJson = {
    style,
    variantCount: group.length,
    priceGroups:  [...new Set(group.map((v) => v.priceGroup).filter(Boolean))],
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
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, TRUE, $12, $13::jsonb, NOW())
    ON CONFLICT (supplier_id, style) DO UPDATE SET
      product_name     = EXCLUDED.product_name,
      fr_product_name  = EXCLUDED.fr_product_name,
      description      = EXCLUDED.description,
      fr_description   = EXCLUDED.fr_description,
      brand            = EXCLUDED.brand,
      discount_code    = EXCLUDED.discount_code,
      price_group      = EXCLUDED.price_group,
      youth            = EXCLUDED.youth,
      case_size        = EXCLUDED.case_size,
      is_discontinued  = EXCLUDED.is_discontinued,
      raw_json         = EXCLUDED.raw_json,
      last_synced_at   = NOW()
    RETURNING id
    `,
    [
      supplierId, style,
      productName, frProductName,
      description, frDescription,
      brand, discountCode, priceGroup,
      youth, caseSize,
      anyDisc,
      JSON.stringify(rawJson),
    ],
  );
  return rows[0].id;
}

async function upsertVariant(client, productId, v) {
  await client.query(
    `
    INSERT INTO supplier_variant (
      product_id, supplier_variant_id,
      size, size_order,
      color_name, fr_color_name,
      weight_lb, image_url,
      quantity, price, sale_price, sale_end_date, currency,
      raw_json, last_synced_at
    )
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, 'CAD', $13::jsonb, NOW())
    ON CONFLICT (product_id, supplier_variant_id) DO UPDATE SET
      size            = EXCLUDED.size,
      size_order      = EXCLUDED.size_order,
      color_name      = EXCLUDED.color_name,
      fr_color_name   = EXCLUDED.fr_color_name,
      weight_lb       = EXCLUDED.weight_lb,
      image_url       = EXCLUDED.image_url,
      quantity        = EXCLUDED.quantity,
      price           = EXCLUDED.price,
      sale_price      = EXCLUDED.sale_price,
      sale_end_date   = EXCLUDED.sale_end_date,
      raw_json        = EXCLUDED.raw_json,
      last_synced_at  = NOW()
    `,
    [
      productId, v.supplierVariantId,
      v.size, sizeSortKey(v.size),
      v.swatchColor, v.frSwatchColor,
      v.weight, v.imageUrl,
      v.quantity, v.price, v.salePrice, v.saleEndDate,
      JSON.stringify({
        productName:   v.productName,
        frProductName: v.frProductName,
        description:   v.description,
        frDescription: v.frDescription,
        brand:         v.brand,
        priceGroup:    v.priceGroup,
        discountCode:  v.discountCode,
        youth:         v.youth,
        caseSize:      v.caseSize,
      }),
    ],
  );
}

// ── Main entrypoint ─────────────────────────────────────────────────────

async function runSanmarIngest({ log = console.log } = {}) {
  const supplier = await queryOne(
    `SELECT id FROM supplier WHERE code = 'sanmar_ca' LIMIT 1`,
  );
  if (!supplier) {
    throw new Error(
      "supplier 'sanmar_ca' not found — run the 002_supplier_catalog migration first",
    );
  }
  const supplierId = supplier.id;

  // Open the audit row first.
  const { rows: syncRows } = await pool.query(
    `INSERT INTO sync_run (supplier_id, kind, status)
     VALUES ($1, 'bulk_data', 'running') RETURNING id`,
    [supplierId],
  );
  const syncId = syncRows[0].id;
  log(`sanmar ingest: sync_run #${syncId} opened`);

  let productsUpserted = 0;
  let variantsUpserted = 0;

  try {
    const client = sanmar.makeClient();
    log(`sanmar ingest: calling GetBulkData (env=${client.config.env})`);
    const { variants, messages } = await client.getBulkData();
    log(`sanmar ingest: ${variants.length} variant rows returned, ${messages.length} messages`);
    for (const m of messages) {
      log(`  message [${m.code}] ${m.label}${m.description ? ' — ' + m.description : ''}`);
    }

    const groups = groupByStyle(variants);
    log(`sanmar ingest: ${groups.size} distinct styles`);

    // One transaction per style keeps failure blast radius small.
    for (const [style, group] of groups) {
      const db = await pool.connect();
      try {
        await db.query('BEGIN');
        const productId = await upsertProduct(db, supplierId, style, group);
        for (const v of group) {
          await upsertVariant(db, productId, v);
          variantsUpserted++;
        }
        await db.query('COMMIT');
        productsUpserted++;
      } catch (e) {
        await db.query('ROLLBACK');
        throw new Error(`style ${style}: ${e.message}`);
      } finally {
        db.release();
      }
    }

    await pool.query(
      `UPDATE sync_run SET
         status = 'success',
         ended_at = NOW(),
         products_upserted = $1,
         variants_upserted = $2
       WHERE id = $3`,
      [productsUpserted, variantsUpserted, syncId],
    );
    log(
      `sanmar ingest: done — products=${productsUpserted} variants=${variantsUpserted}`,
    );
    return { syncId, productsUpserted, variantsUpserted, messages };
  } catch (e) {
    await pool.query(
      `UPDATE sync_run SET
         status = 'failed',
         ended_at = NOW(),
         products_upserted = $1,
         variants_upserted = $2,
         error_message = $3
       WHERE id = $4`,
      [productsUpserted, variantsUpserted, e.message, syncId],
    );
    log(`sanmar ingest: FAILED — ${e.message}`);
    throw e;
  }
}

module.exports = { runSanmarIngest, sizeSortKey, groupByStyle, looksDiscontinued };

// CLI entry point — only run when invoked directly.
if (require.main === module) {
  runSanmarIngest()
    .then(() => pool.end())
    .catch((e) => { console.error(e.stack || e.message); pool.end(); process.exit(1); });
}
