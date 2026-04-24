// lib/dtf-pricing.js
// DTF online-store pricing engine.
//
// Single source of truth for what an online order costs. Used both by the
// frontend (read-only, via POST /api/orders/quote during cart edits) and
// by the backend at checkout time (authoritative — what we actually charge
// the card). The frontend's calculation is display-only; the backend always
// recomputes from scratch before billing.
//
// Inputs:
//   - cart: an in-memory cart object (line items + decorations + designs)
//   - config: { printLocations, printLocationPrices, dtfCustomTiers,
//               taxRates, applyShipping, applyTax }
//   - shipTo: { province, country }   -- needed for tax rate
//   - shippingTotal: number (CAD dollars), 0 for pickup
//
// All money values are CAD dollars (Number, two-decimal rounded). Money
// snapshots stored on the order rows are also dollars. Cents-only money
// only appears when calling out to QB Payments / ShipTime APIs (those
// take cents).
//
// Quantity tiering is per-design, NOT per-order. If a customer puts the
// same logo on shirts and hoodies in one order, the quantities aggregate
// across all order_items that reference that design. Each unique design
// has its own tier driver.

'use strict';

// ─── helpers ─────────────────────────────────────────────────────────────────

function round2(n) {
  // Round half away from zero, two decimals. Banker's rounding can produce
  // accounting confusion; classic round-half-up is what humans expect on
  // invoices.
  if (!Number.isFinite(n)) return 0;
  return Math.round(n * 100) / 100;
}

// Find the matching tier for a quantity across a tier list.
// Tiers are { min_quantity, max_quantity (nullable = unlimited), ... }.
// Returns the matching tier or undefined if no tier covers the quantity.
function findTier(tiers, quantity) {
  return tiers.find((t) => {
    if (quantity < t.min_quantity) return false;
    if (t.max_quantity == null) return true;
    return quantity <= t.max_quantity;
  });
}

// ─── per-decoration cost ─────────────────────────────────────────────────────

// Compute the cost of decorating ONE piece for a given decoration spec.
// Returns 0 if no matching tier (treat as unpriced; backend should warn).
//
// designQuantity: total pieces across the order using this decoration's design
// decoration: { print_location_id?, width_in?, height_in? }
// config: { printLocations, printLocationPrices, dtfCustomTiers }
function decorationUnitCost(decoration, designQuantity, config) {
  const isCustom = decoration.print_location_id == null;

  if (isCustom) {
    const tier = findTier(config.dtfCustomTiers, designQuantity);
    if (!tier) return 0;
    const sqIn = (Number(decoration.width_in) || 0) * (Number(decoration.height_in) || 0);
    const raw  = sqIn * Number(tier.price_per_sqin);
    return Math.max(raw, Number(tier.min_per_piece));
  }

  // Standard location: look up tier in print_location_prices for this loc.
  const prices = config.printLocationPrices.filter(
    (p) => p.print_location_id === decoration.print_location_id
  );
  const tier = findTier(prices, designQuantity);
  return tier ? Number(tier.price_per_piece) : 0;
}

// Setup fee: applied once per design, custom-only, waived at 48+.
function setupFeeForDesign(designQuantity, config) {
  // Only custom designs incur setup. We detect "custom design" by checking
  // if the design has any decorations with print_location_id NULL (handled
  // by caller). This function just returns the fee given the quantity.
  const tier = findTier(config.dtfCustomTiers, designQuantity);
  return tier ? Number(tier.setup_fee_per_design) : 0;
}

// ─── tax ─────────────────────────────────────────────────────────────────────

function taxRateFor(province, taxRates) {
  if (!province) return 0;
  const row = taxRates.find((t) => t.province_code === province.toUpperCase());
  return row ? Number(row.rate) : 0;
}

// ─── main ────────────────────────────────────────────────────────────────────

// Compute the full price breakdown for a cart.
//
// cart shape:
//   {
//     items: [
//       {
//         id: <client-side temp id; not persisted>,
//         supplier, style, variant_id, product_name, color_name, color_hex,
//         size, quantity, unit_price (garment retail),
//         decorations: [
//           {
//             id, design_id (uuid),
//             print_location_id (null = custom),
//             custom_location, width_in, height_in
//           }
//         ]
//       }
//     ],
//     designs: [ { id, name, ... } ]   // optional; not used in math
//   }
//
// Returns:
//   {
//     items_subtotal,
//     decorations_subtotal,
//     setup_total,
//     subtotal,                  // items + decorations + setup
//     shipping_total,
//     taxable_subtotal,          // subtotal + shipping
//     tax_rate,                  // e.g. 0.13
//     tax_total,
//     grand_total,
//     line_breakdown: [          // one entry per cart item, expanded
//       {
//         item_id, garment_subtotal,
//         decorations: [
//           {
//             decoration_id, design_id, design_quantity,
//             unit_cost, line_cost, setup_fee
//           }
//         ],
//         line_total
//       }
//     ],
//     warnings: [string]         // e.g. "no tier covers quantity X"
//   }
function priceCart({ cart, config, shipTo, shippingTotal = 0 }) {
  const warnings = [];
  const items     = cart.items || [];
  const taxRates  = config.taxRates || [];

  // Step 1: aggregate quantity per design (across all items + decorations).
  const designQty = new Map();   // design_id -> total piece count
  const designIsCustom = new Map(); // design_id -> bool (any decoration custom)
  for (const item of items) {
    const qty = Number(item.quantity) || 0;
    for (const dec of (item.decorations || [])) {
      if (!dec.design_id) continue;
      designQty.set(dec.design_id, (designQty.get(dec.design_id) || 0) + qty);
      if (dec.print_location_id == null) designIsCustom.set(dec.design_id, true);
    }
  }

  // Step 2: compute per-line breakdown.
  let itemsSubtotal       = 0;
  let decorationsSubtotal = 0;
  let setupTotal          = 0;
  const lineBreakdown     = [];
  const setupBilledFor    = new Set(); // design_ids we've already billed setup for

  for (const item of items) {
    const qty           = Number(item.quantity) || 0;
    const unitPrice     = Number(item.unit_price) || 0;
    const garmentSubtot = round2(qty * unitPrice);
    itemsSubtotal      += garmentSubtot;

    const decBreakdown = [];
    let lineTotal = garmentSubtot;

    for (const dec of (item.decorations || [])) {
      const designQuantity = designQty.get(dec.design_id) || qty;
      const unitCost       = decorationUnitCost(dec, designQuantity, config);
      const lineCost       = round2(qty * unitCost);

      if (unitCost === 0 && qty > 0) {
        warnings.push(
          `No price tier matched decoration on ${item.product_name || item.style} ` +
          `(design qty ${designQuantity}). Decoration cost set to $0.`
        );
      }

      decorationsSubtotal += lineCost;
      lineTotal           += lineCost;

      // Setup fee: custom designs only, once per design across the whole order.
      let setupFee = 0;
      if (designIsCustom.get(dec.design_id) && !setupBilledFor.has(dec.design_id)) {
        setupFee = setupFeeForDesign(designQuantity, config);
        if (setupFee > 0) {
          setupTotal += setupFee;
          lineTotal  += setupFee;
        }
        setupBilledFor.add(dec.design_id);
      }

      decBreakdown.push({
        decoration_id:   dec.id || null,
        design_id:       dec.design_id,
        design_quantity: designQuantity,
        unit_cost:       round2(unitCost),
        line_cost:       lineCost,
        setup_fee:       setupFee,
      });
    }

    lineBreakdown.push({
      item_id:          item.id || null,
      garment_subtotal: garmentSubtot,
      decorations:      decBreakdown,
      line_total:       round2(lineTotal),
    });
  }

  const subtotal        = round2(itemsSubtotal + decorationsSubtotal + setupTotal);
  const ship            = round2(Number(shippingTotal) || 0);
  const taxableSubtotal = round2(subtotal + ship);
  const taxRate         = taxRateFor(shipTo?.province, taxRates);
  const taxTotal        = round2(taxableSubtotal * taxRate);
  const grandTotal      = round2(taxableSubtotal + taxTotal);

  return {
    items_subtotal:       round2(itemsSubtotal),
    decorations_subtotal: round2(decorationsSubtotal),
    setup_total:          round2(setupTotal),
    subtotal,
    shipping_total:       ship,
    taxable_subtotal:     taxableSubtotal,
    tax_rate:             taxRate,
    tax_total:            taxTotal,
    grand_total:          grandTotal,
    line_breakdown:       lineBreakdown,
    warnings,
  };
}

module.exports = {
  // public api
  priceCart,
  // exported for tests
  _internals: {
    round2,
    findTier,
    decorationUnitCost,
    setupFeeForDesign,
    taxRateFor,
  },
};
