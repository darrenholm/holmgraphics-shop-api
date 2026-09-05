// lib/election-apparel.js
//
// Shirts, hoodies and polos on the election order form.
//
// NOT PRICED HERE. lib/dtf-pricing.js is the shop's apparel engine — print
// locations, quantity tiers, setup billed once per design — and this asks it
// rather than keeping a second set of rules that would drift from the one the
// counter uses. The election price list (lib/election-catalogue.js) covers
// signs, cards and decals; apparel is the one thing on that form the shop
// already had a proper answer for.
//
// The garment's own retail comes from the same rule the storefront applies
// (src/lib/shop/pricing.js in the shop repo): under $5 wholesale it is $10 flat,
// otherwise wholesale doubled. It is computed here rather than in the browser,
// which is where that file says it should have been all along — a page that
// gets sent a wholesale price is a page that leaks it.
//
// TIERING IS PER DESIGN, NOT PER LINE, and a campaign is one design: the same
// logo on tees and hoodies. So every apparel row in one basket shares a design
// id, and the quantities add up across them to find the tier. That is how the
// shop quotes it at the counter, and it is the difference between a dozen
// shirts priced as a dozen and priced as three lots of four.

'use strict';

const { query } = require('../db/connection');
const { priceCart } = require('./dtf-pricing');
const { getConfig } = require('./dtf-pricing-loader');

const SUPPLIER_CODE = 'sanmar_ca';

/**
 * What a campaign can put a logo on.
 *
 * Darren's list, September 2026. Kept short on purpose: a candidate choosing
 * from six styles orders, and a candidate choosing from six hundred rings up
 * to ask which one is any good.
 */
const ELECTION_STYLES = [
  { style: 'ATC1000',  label: 'T-shirt' },
  { style: 'ATCF6500', label: 'Hoodie — crewneck' },
  { style: 'ATCF6600', label: 'Hoodie — pullover' },
  { style: 'ATCF6700', label: 'Hoodie — full zip' },
  { style: 'S365',     label: 'Polo' },
  { style: 'SL365',    label: 'Polo — ladies' },
];

/**
 * Wholesale to retail, the shop's own rule.
 *
 * Mirrors apparelPrice() in the storefront. If that changes, change this with
 * it — or better, delete that one and let the browser use what this returns.
 */
function apparelRetail(wholesale) {
  const cost = Number(wholesale);
  if (!Number.isFinite(cost)) return null;
  if (cost < 5) return 10;
  return Math.round(cost * 2 * 100) / 100;
}

/**
 * Every style, colour and size a campaign can order, with retail prices.
 *
 * One query rather than six, because this is rendered on a page load and a
 * candidate should not wait on a round trip per style.
 */
async function apparelOptions() {
  const styles = ELECTION_STYLES.map((s) => s.style);

  const rows = await query(
    `SELECT p.style,
            p.product_name,
            v.id           AS variant_id,
            v.size,
            v.size_order,
            v.color_name,
            v.color_hex,
            v.quantity,
            COALESCE(v.sale_price, v.price) AS wholesale
       FROM supplier_variant v
       JOIN supplier_product p ON p.id = v.product_id
       JOIN supplier s         ON s.id = p.supplier_id
      WHERE s.code = $1
        AND p.style = ANY($2::text[])
      ORDER BY p.style, v.color_name NULLS LAST, v.size_order NULLS LAST, v.size`,
    [SUPPLIER_CODE, styles],
  );

  const byStyle = new Map();
  for (const row of rows) {
    const retail = apparelRetail(row.wholesale);
    // A size with no cost cannot be sold: it would price at nothing and look
    // deliberate. Left out rather than shown at zero.
    if (retail === null) continue;

    const entry = byStyle.get(row.style) || {
      style: row.style,
      label: ELECTION_STYLES.find((s) => s.style === row.style)?.label || row.style,
      name: row.product_name,
      colours: new Map(),
    };

    const colour = entry.colours.get(row.color_name) || {
      name: row.color_name,
      hex: row.color_hex,
      sizes: [],
    };
    colour.sizes.push({
      variant_id: row.variant_id,
      size: row.size,
      price: retail,
      // Nothing is blocked on stock — the shop orders these in — but it is
      // worth knowing which sizes are short before promising a date.
      in_stock: Number(row.quantity) > 0,
    });
    entry.colours.set(row.color_name, colour);
    byStyle.set(row.style, entry);
  }

  // The catalogue in the order the list above names, not the order the
  // database happened to return.
  return ELECTION_STYLES
    .map(({ style }) => byStyle.get(style))
    .filter(Boolean)
    .map((entry) => ({ ...entry, colours: [...entry.colours.values()] }));
}

/** Where a design can go, and what each placement costs by quantity. */
async function printLocations() {
  const { printLocations: locs, printLocationPrices } = await getConfig();
  return (locs || [])
    .filter((l) => !l.garment_category || l.garment_category === 'apparel')
    .map((l) => ({
      id: l.id,
      name: l.name,
      tiers: (printLocationPrices || [])
        .filter((p) => p.print_location_id === l.id)
        .map((p) => ({
          min_quantity: p.min_quantity,
          max_quantity: p.max_quantity,
          price_per_piece: Number(p.price_per_piece),
        })),
    }));
}

/**
 * Price the apparel on an order, as job lines.
 *
 * `rows` are what the form holds: a style, a colour, a print location, and how
 * many of each size. Every row shares one design id so the tiers see the whole
 * campaign's quantity, which is what makes twelve shirts cost what twelve
 * shirts cost.
 *
 * Returns lines shaped like the rest of the election catalogue's, so the form
 * and the job builder do not care which engine priced them.
 */
async function priceApparel(rows) {
  if (!Array.isArray(rows) || rows.length === 0) return { lines: [], warnings: [] };

  const config = await getConfig();
  const options = await apparelOptions();

  const cartItems = [];
  const rowIndexByItemId = new Map();

  rows.forEach((row, index) => {
    const style = options.find((s) => s.style === row.style);
    if (!style) return;
    const colour =
      style.colours.find((c) => c.name === row.colour) || style.colours[0];
    if (!colour) return;

    const locationId = Number(row.print_location_id);
    if (!Number.isFinite(locationId)) return;

    for (const [size, count] of Object.entries(row.sizes || {})) {
      const wanted = Math.round(Number(count));
      if (!Number.isFinite(wanted) || wanted <= 0) continue;

      const sku = colour.sizes.find((s) => s.size === size);
      if (!sku) continue;

      const itemId = `row${index}-${size}`;
      rowIndexByItemId.set(itemId, index);
      cartItems.push({
        id: itemId,
        supplier: SUPPLIER_CODE,
        style: style.style,
        variant_id: sku.variant_id,
        product_name: style.name,
        color_name: colour.name,
        size,
        quantity: wanted,
        unit_price: sku.price,
        // One design across the whole basket: a campaign puts the same mark on
        // everything, and the tier should see all of it.
        decorations: [{ id: `${itemId}-d`, design_id: 'election', print_location_id: locationId }],
      });
    }
  });

  if (cartItems.length === 0) return { lines: [], warnings: [] };

  // Pickup, and tax is added by the election form's own summary rather than
  // here, so this asks for neither.
  const priced = priceCart({
    cart: { items: cartItems },
    config,
    shipTo: {},
    shippingTotal: 0,
  });

  // Back to one line per row: the engine works per garment, the job board
  // wants "18 t-shirts, navy, left chest".
  const totals = new Map();
  for (const entry of priced.line_breakdown || []) {
    const index = rowIndexByItemId.get(entry.item_id);
    if (index === undefined) continue;
    const running = totals.get(index) || { total: 0, quantity: 0 };
    running.total += entry.line_total;
    const item = cartItems.find((c) => c.id === entry.item_id);
    running.quantity += item ? item.quantity : 0;
    totals.set(index, running);
  }

  const lines = [];
  for (const [index, running] of [...totals.entries()].sort((a, b) => a[0] - b[0])) {
    const row = rows[index];
    const style = options.find((s) => s.style === row.style);
    const colour = style?.colours.find((c) => c.name === row.colour) || style?.colours[0];
    const location = (config.printLocations || []).find(
      (l) => l.id === Number(row.print_location_id),
    );
    const sizeRun = Object.entries(row.sizes || {})
      .filter(([, n]) => Number(n) > 0)
      .map(([size, n]) => `${n} × ${size}`)
      .join(', ');

    const total = Math.round(running.total * 100) / 100;
    lines.push({
      item_type: 'Apparel',
      description:
        `${style?.label || row.style} ${style?.style || ''} — ${colour?.name || 'colour TBC'}` +
        `${location ? `, printed ${location.name.toLowerCase()}` : ''}` +
        `${sizeRun ? ` (${sizeRun})` : ''}`,
      quantity: running.quantity,
      unit_price: running.quantity > 0
        ? Math.round((total / running.quantity) * 100) / 100
        : 0,
      total,
      source: { kind: 'apparel', index },
    });
  }

  return { lines, warnings: priced.warnings || [] };
}

module.exports = {
  ELECTION_STYLES,
  SUPPLIER_CODE,
  apparelRetail,
  apparelOptions,
  printLocations,
  priceApparel,
};
