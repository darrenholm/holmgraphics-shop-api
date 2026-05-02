// lib/order-pricing-overrides.js
//
// Per-line unit_price override applied before the cart is handed to
// priceCart. Used by the office-order endpoint so staff can quote a
// custom price for a specific item without having to manipulate the
// catalog. priceCart reads cart.items[].unit_price directly, so the
// cleanest plug-in is just to swap the unit_price on each item that
// has an override before pricing runs.
//
// Online orders never call this; they skip overrides entirely.

'use strict';

/**
 * Validate the shape of an unit_price_overrides object. Returns the
 * sanitised object on success; throws on the first invalid entry so
 * the caller can return a 400 with a clear field name.
 *
 * Acceptable shape:
 *   { [item_id_string]: number }   -- non-negative finite numbers only.
 *
 * Returns {} for null/undefined/empty input; caller can pass the result
 * straight into applyUnitPriceOverrides.
 */
function validateUnitPriceOverrides(raw) {
  if (raw == null) return {};
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error('unit_price_overrides must be an object keyed by cart item id');
  }
  const out = {};
  for (const [id, value] of Object.entries(raw)) {
    if (id === '') {
      throw new Error('unit_price_overrides: empty item id');
    }
    const n = Number(value);
    if (!Number.isFinite(n) || n < 0) {
      throw new Error(`unit_price_overrides: ${id} must be a non-negative number (got ${JSON.stringify(value)})`);
    }
    out[id] = n;
  }
  return out;
}

/**
 * Returns a NEW cart object with item.unit_price replaced for any item
 * whose id appears in overrides. Items not in overrides are left intact.
 * Pure -- no mutation of the input cart.
 */
function applyUnitPriceOverrides(cart, overrides) {
  if (!cart || !Array.isArray(cart.items)) return cart;
  if (!overrides || Object.keys(overrides).length === 0) return cart;
  return {
    ...cart,
    items: cart.items.map((it) => {
      if (Object.prototype.hasOwnProperty.call(overrides, it.id)) {
        return { ...it, unit_price: overrides[it.id] };
      }
      return it;
    }),
  };
}

module.exports = { validateUnitPriceOverrides, applyUnitPriceOverrides };
