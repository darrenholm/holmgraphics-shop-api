// routes/dtf-config.js
// Read-only public endpoints that expose the DTF pricing configuration
// so the cart UI can render the location dropdown, show tier prices, etc.
//
// Mounted at /api/dtf — e.g. GET /api/dtf/print-locations.
//
// Admin (write) routes for the same tables live in routes/dtf-admin.js
// and are gated behind requireAdmin.

'use strict';

const express = require('express');
const { getConfig } = require('../lib/dtf-pricing-loader');

const router = express.Router();

// GET /api/dtf/print-locations[?category=apparel]
router.get('/print-locations', async (req, res) => {
  try {
    const { printLocations, printLocationPrices } = await getConfig();
    const filter = req.query.category;
    const locs = filter
      ? printLocations.filter((l) => l.garment_category === filter)
      : printLocations;

    // Attach the tier list to each location so frontend can show "$6 each (1-11), $5 (12-23) ..."
    const out = locs.map((loc) => ({
      ...loc,
      tiers: printLocationPrices
        .filter((p) => p.print_location_id === loc.id)
        .map((p) => ({
          min_quantity:    p.min_quantity,
          max_quantity:    p.max_quantity,
          price_per_piece: Number(p.price_per_piece),
        })),
    }));

    res.json({ print_locations: out });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/dtf/custom-tiers
router.get('/custom-tiers', async (req, res) => {
  try {
    const { dtfCustomTiers } = await getConfig();
    res.json({
      tiers: dtfCustomTiers.map((t) => ({
        min_quantity:         t.min_quantity,
        max_quantity:         t.max_quantity,
        price_per_sqin:       Number(t.price_per_sqin),
        min_per_piece:        Number(t.min_per_piece),
        setup_fee_per_design: Number(t.setup_fee_per_design),
      })),
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/dtf/tax-rates
router.get('/tax-rates', async (req, res) => {
  try {
    const { taxRates } = await getConfig();
    res.json({
      tax_rates: taxRates.map((t) => ({
        province_code: t.province_code,
        rate:          Number(t.rate),
        rate_label:    t.rate_label,
      })),
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
