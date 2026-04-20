// routes/catalog.js
//
// Public read-only catalog browsing. No auth required — this is the
// supplier catalog that powers the storefront.
//
// Endpoints:
//   GET /api/catalog/search    — paginated + filterable product list.
//   GET /api/catalog/brands    — distinct brand list for filter UI.
//   GET /api/catalog/:supplier/:style — one product with all variants.
//
// "Blank-sale blocked" brands (Nike, Eddie Bauer, etc.) DO appear in
// search results — the storefront just hides add-to-cart and shows an
// "embellishment required" badge instead. The `is_blocked_from_blank_sale`
// flag in each response lets the UI decide.

const express = require('express');
const { query, queryOne } = require('../db/connection');

const router = express.Router();

const MAX_LIMIT = 100;

// ─── GET /api/catalog/search ─────────────────────────────────────────────────
// Query params (all optional):
//   q           — name/description ILIKE match
//   brand       — repeat or comma-separated list; case-insensitive
//   supplier    — supplier code (sanmar_ca, ...)
//   in_stock    — '1' / 'true' to hide out-of-stock products
//   include_discontinued — '1' to show discontinued (hidden by default)
//   page        — default 1
//   limit       — default 24, max 100
//   sort        — 'name' (default), 'price_asc', 'price_desc', 'newest'
router.get('/search', async (req, res) => {
  try {
    const page  = Math.max(parseInt(req.query.page, 10)  || 1, 1);
    const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 24, 1), MAX_LIMIT);
    const offset = (page - 1) * limit;

    const q = typeof req.query.q === 'string' ? req.query.q.trim() : '';
    const brandsParam = req.query.brand;
    const brandList = []
      .concat(brandsParam || [])
      .flatMap((b) => String(b).split(','))
      .map((b) => b.trim())
      .filter(Boolean);
    const supplier = typeof req.query.supplier === 'string' ? req.query.supplier.trim() : '';
    const inStockOnly = req.query.in_stock === '1' || req.query.in_stock === 'true';
    const includeDiscontinued =
      req.query.include_discontinued === '1' || req.query.include_discontinued === 'true';

    const sortMap = {
      name:       'p.product_name ASC NULLS LAST, p.style ASC',
      price_asc:  'min_price ASC NULLS LAST, p.product_name ASC',
      price_desc: 'max_price DESC NULLS LAST, p.product_name ASC',
      newest:     'p.first_seen_at DESC',
    };
    const orderBy = sortMap[req.query.sort] || sortMap.name;

    const params = [];
    const where = ['p.is_sellable = TRUE'];
    if (!includeDiscontinued) where.push('p.is_discontinued = FALSE');

    if (q) {
      params.push(`%${q}%`);
      where.push(`(p.product_name ILIKE $${params.length} OR p.description ILIKE $${params.length} OR p.style ILIKE $${params.length})`);
    }
    if (brandList.length) {
      params.push(brandList.map((b) => b.toLowerCase()));
      where.push(`LOWER(p.brand) = ANY($${params.length}::text[])`);
    }
    if (supplier) {
      params.push(supplier);
      where.push(`s.code = $${params.length}`);
    }

    // Build the SELECT — subqueries are fine at this scale (a few thousand
    // products per supplier). Promote to denormalised columns if it starts
    // to hurt.
    const selectRows = `
      SELECT
        p.id,
        p.style,
        p.product_name,
        p.fr_product_name,
        p.brand,
        s.code AS supplier,
        s.name AS supplier_name,
        p.is_discontinued,
        (SELECT image_url FROM supplier_variant v
           WHERE v.product_id = p.id AND v.image_url IS NOT NULL
           ORDER BY v.size_order NULLS LAST LIMIT 1) AS image_url,
        (SELECT COUNT(DISTINCT color_name)::int FROM supplier_variant v
           WHERE v.product_id = p.id) AS color_count,
        (SELECT COUNT(*)::int FROM supplier_variant v
           WHERE v.product_id = p.id) AS variant_count,
        (SELECT MIN(price) FROM supplier_variant v
           WHERE v.product_id = p.id AND v.price IS NOT NULL) AS min_price,
        (SELECT MAX(price) FROM supplier_variant v
           WHERE v.product_id = p.id AND v.price IS NOT NULL) AS max_price,
        EXISTS (SELECT 1 FROM supplier_variant v
           WHERE v.product_id = p.id AND v.quantity > 0) AS has_stock,
        EXISTS (SELECT 1 FROM brand_restriction br
           WHERE LOWER(br.brand) = LOWER(p.brand) AND br.blocked_from_blank_sale) AS is_blocked_from_blank_sale
      FROM supplier_product p
      JOIN supplier s ON s.id = p.supplier_id
      WHERE ${where.join(' AND ')}
    `;

    // Wrap with an in-stock filter so HAVING-style logic stays readable.
    const outer = inStockOnly
      ? `SELECT * FROM (${selectRows}) ranked WHERE has_stock = TRUE`
      : selectRows;

    // Total count — re-use the WHERE + in-stock filter.
    const countSql = `SELECT COUNT(*)::int AS n FROM (${outer}) counted`;

    // Page of results.
    params.push(limit);  const limitIdx  = params.length;
    params.push(offset); const offsetIdx = params.length;
    const pageSql = `${outer} ORDER BY ${orderBy} LIMIT $${limitIdx} OFFSET $${offsetIdx}`;

    // pg returns array; query() returns just .rows.
    const [items, totalRows] = await Promise.all([
      query(pageSql, params),
      query(countSql, params.slice(0, params.length - 2)),
    ]);
    const total = totalRows[0]?.n || 0;

    res.json({ page, limit, total, items });
  } catch (e) {
    console.error('GET /catalog/search:', e);
    res.status(500).json({ message: 'Catalog search failed', detail: e.message });
  }
});

// ─── GET /api/catalog/brands ─────────────────────────────────────────────────
// Distinct brands across all suppliers, with a count of active products
// per brand (useful for showing "(42)" beside each in filter UI).
router.get('/brands', async (req, res) => {
  try {
    const rows = await query(`
      SELECT
        p.brand,
        COUNT(*)::int AS product_count,
        EXISTS (SELECT 1 FROM brand_restriction br
           WHERE LOWER(br.brand) = LOWER(p.brand) AND br.blocked_from_blank_sale
        ) AS is_blocked_from_blank_sale
      FROM supplier_product p
      WHERE p.is_sellable = TRUE
        AND p.is_discontinued = FALSE
        AND p.brand IS NOT NULL
      GROUP BY p.brand
      ORDER BY p.brand
    `);
    res.json(rows);
  } catch (e) {
    console.error('GET /catalog/brands:', e);
    res.status(500).json({ message: 'Failed to load brands', detail: e.message });
  }
});

// ─── GET /api/catalog/:supplier/:style ───────────────────────────────────────
// Full product detail with every variant. Supplier code is required in the
// path so the same style (e.g. "2000") can exist in multiple supplier catalogs
// without collisions.
router.get('/:supplier/:style', async (req, res) => {
  const { supplier: supplierCode, style } = req.params;
  try {
    const product = await queryOne(
      `
      SELECT
        p.id,
        p.style,
        p.product_name,
        p.fr_product_name,
        p.description,
        p.fr_description,
        p.brand,
        p.discount_code,
        p.price_group,
        p.youth,
        p.case_size,
        p.is_sellable,
        p.is_discontinued,
        p.last_synced_at,
        s.code AS supplier,
        s.name AS supplier_name,
        (SELECT row_to_json(br) FROM brand_restriction br
           WHERE LOWER(br.brand) = LOWER(p.brand) LIMIT 1) AS brand_restriction
      FROM supplier_product p
      JOIN supplier s ON s.id = p.supplier_id
      WHERE s.code = $1 AND p.style = $2
      LIMIT 1
      `,
      [supplierCode, style],
    );
    if (!product) return res.status(404).json({ message: 'Product not found' });

    const variants = await query(
      `
      SELECT
        id,
        supplier_variant_id,
        size,
        size_order,
        color_name,
        fr_color_name,
        color_hex,
        weight_lb,
        image_url,
        quantity,
        price,
        sale_price,
        sale_end_date,
        currency,
        last_synced_at
      FROM supplier_variant
      WHERE product_id = $1
      ORDER BY color_name NULLS LAST, size_order NULLS LAST, size
      `,
      [product.id],
    );

    res.json({
      ...product,
      is_blocked_from_blank_sale: !!product.brand_restriction?.blocked_from_blank_sale,
      variants,
    });
  } catch (e) {
    console.error('GET /catalog/:supplier/:style:', e);
    res.status(500).json({ message: 'Failed to load product', detail: e.message });
  }
});

module.exports = router;
