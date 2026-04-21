// scripts/inspect-image-urls.js
//
// Prod diagnostic for #67 — "missing product images on shop".
// Run via: `railway run node scripts/inspect-image-urls.js`
//
// The storefront renders whatever is in supplier_variant.image_url directly
// as an <img src>. If the feed gives us a relative path, a null, or a host
// the browser can't reach, products render the "No image" placeholder.
// This script summarises the shape of what's actually stored so we know
// whether the fix belongs in ingest (rewrite URL), in config (hosts to
// allow), or in the frontend (fallback heuristic).

const { query } = require('../db/connection');

(async () => {
  // 1. Overall coverage.
  const [{ total, with_url, null_url, empty_url }] = await query(`
    SELECT
      COUNT(*)::int                                               AS total,
      COUNT(*) FILTER (WHERE image_url IS NOT NULL
                         AND image_url <> '')::int                AS with_url,
      COUNT(*) FILTER (WHERE image_url IS NULL)::int              AS null_url,
      COUNT(*) FILTER (WHERE image_url = '')::int                 AS empty_url
    FROM supplier_variant
  `);
  console.log('\n=== supplier_variant image_url coverage ===');
  console.log(`  total variants : ${total}`);
  console.log(`  with URL       : ${with_url}  (${((with_url / total) * 100).toFixed(1)}%)`);
  console.log(`  NULL           : ${null_url}`);
  console.log(`  empty string   : ${empty_url}`);

  // 2. Host histogram — group by "scheme://host".
  const hosts = await query(`
    SELECT
      CASE
        WHEN image_url ~ '^https?://'
          THEN regexp_replace(image_url, '^(https?://[^/]+).*', '\\1')
        WHEN image_url ~ '^//'
          THEN regexp_replace(image_url, '^(//[^/]+).*', '\\1')
        WHEN image_url = '' OR image_url IS NULL
          THEN '(empty)'
        ELSE '(relative path — no scheme)'
      END AS host,
      COUNT(*)::int AS n
    FROM supplier_variant
    GROUP BY 1
    ORDER BY n DESC
  `);
  console.log('\n=== Host histogram ===');
  for (const r of hosts) console.log(`  ${String(r.n).padStart(6)}  ${r.host}`);

  // 3. Ten random non-null samples so we can eyeball the format.
  const samples = await query(`
    SELECT p.style, v.color_name, v.size, v.image_url
    FROM supplier_variant v
    JOIN supplier_product p ON p.id = v.product_id
    WHERE v.image_url IS NOT NULL AND v.image_url <> ''
    ORDER BY random()
    LIMIT 10
  `);
  console.log('\n=== Sample non-empty image_url values ===');
  for (const r of samples) {
    console.log(`  ${r.style.padEnd(10)} ${String(r.color_name || '').padEnd(18)} ${String(r.size || '').padEnd(6)}  ${r.image_url}`);
  }

  // 4. Ten random rows that have NO image — so we can see what styles
  //    are affected and whether they're recent or missing from the feed.
  const missing = await query(`
    SELECT p.style, p.product_name, p.brand, v.color_name, v.size
    FROM supplier_variant v
    JOIN supplier_product p ON p.id = v.product_id
    WHERE v.image_url IS NULL OR v.image_url = ''
    ORDER BY random()
    LIMIT 10
  `);
  console.log('\n=== Sample rows with NO image_url ===');
  for (const r of missing) {
    console.log(`  ${r.style.padEnd(10)} ${String(r.brand || '').padEnd(14)} ${String(r.color_name || '').padEnd(18)} ${String(r.size || '').padEnd(6)}  ${r.product_name}`);
  }

  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
