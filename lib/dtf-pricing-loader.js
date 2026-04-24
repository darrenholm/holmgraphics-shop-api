// lib/dtf-pricing-loader.js
// Pulls the DTF pricing configuration out of Postgres into the shape that
// lib/dtf-pricing.js expects. Cached in-process for one minute so the
// pricing engine doesn't hit the DB on every cart edit.
//
// Cache invalidation: any update via the admin pricing routes calls
// `bustCache()` so changes go live immediately.

'use strict';

const { query } = require('../db/connection');

const TTL_MS = 60_000;
let _cache = null;

async function loadConfig() {
  const [printLocations, printLocationPrices, dtfCustomTiers, taxRates] = await Promise.all([
    query(`SELECT id, garment_category, name, max_width_in, max_height_in,
                  display_order, active
             FROM print_locations
            WHERE active = TRUE
            ORDER BY garment_category, display_order, name`),
    query(`SELECT id, print_location_id, min_quantity, max_quantity, price_per_piece
             FROM print_location_prices
            ORDER BY print_location_id, min_quantity`),
    query(`SELECT id, min_quantity, max_quantity, price_per_sqin,
                  min_per_piece, setup_fee_per_design
             FROM dtf_custom_tiers
            ORDER BY min_quantity`),
    query(`SELECT province_code, rate, rate_label
             FROM tax_rates`),
  ]);

  return { printLocations, printLocationPrices, dtfCustomTiers, taxRates };
}

async function getConfig() {
  if (_cache && _cache.expiresAt > Date.now()) {
    return _cache.config;
  }
  const config = await loadConfig();
  _cache = { config, expiresAt: Date.now() + TTL_MS };
  return config;
}

function bustCache() {
  _cache = null;
}

module.exports = { getConfig, bustCache, _internals: { loadConfig } };
