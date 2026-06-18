// routes/fleet-telematics.js
// Provider-agnostic telematics READ layer. The live map and the per-vehicle
// UI read from here and never need to know WHICH provider supplied the data —
// they get each vehicle's latest position/odometer/fuel + a `source` label.
//
// Today the only provider is Ford Pro (fordpro_vehicles, migration 049). To
// add another later (e.g. Smartcar for non-Ford makes), add its rows to the
// provider subquery below (UNION ALL, then pick the most-recent per vehicle) —
// the endpoints and the entire frontend stay unchanged. That's the whole point
// of this layer: the fleet isn't locked to Ford.
//
//   GET /api/fleet/telematics/locations    → active vehicles linked to ANY provider
//   GET /api/fleet/telematics/vehicle/:id   → one vehicle's latest reading

'use strict';

const express = require('express');
const { query, queryOne } = require('../db/connection');
const { requireStaff } = require('../middleware/auth');

const router = express.Router();
router.use(express.json());

// Normalized columns every provider maps into. The `prov` subquery is where
// new providers get UNION ALL'd in (then DISTINCT ON most-recent per vehicle).
const TELEMETRY_SELECT = `
  SELECT v.id          AS vehicle_id,
         v.unit_number, v.type, v.make, v.model, v.year, v.vin,
         prov.source,
         prov.lat, prov.lon, prov.location_at,
         prov.odometer_km, prov.fuel_pct, prov.ignition, prov.battery_volts,
         prov.updated_at
    FROM vehicles v
    LEFT JOIN (
      SELECT DISTINCT ON (vehicle_id) *
        FROM (
          -- ── Ford Pro provider ──
          SELECT vehicle_id,
                 'Ford Pro'         AS source,
                 last_location_lat  AS lat,
                 last_location_lon  AS lon,
                 last_location_at   AS location_at,
                 last_odometer_km   AS odometer_km,
                 last_fuel_pct      AS fuel_pct,
                 last_ignition      AS ignition,
                 last_battery_volts AS battery_volts,
                 last_fetched_at    AS updated_at
            FROM fordpro_vehicles
           WHERE vehicle_id IS NOT NULL
          -- ── future providers UNION ALL here ──
        ) all_providers
       ORDER BY vehicle_id, updated_at DESC NULLS LAST
    ) prov ON prov.vehicle_id = v.id
`;

// All vehicles with a telematics link (any provider) — for the live map.
router.get('/fleet/telematics/locations', requireStaff, async (req, res, next) => {
  try {
    const rows = await query(
      `${TELEMETRY_SELECT}
        WHERE (v.active IS TRUE OR v.active IS NULL)
          AND prov.source IS NOT NULL
        ORDER BY v.unit_number NULLS LAST`
    );
    res.json({ vehicles: rows });
  } catch (e) { next(e); }
});

// One vehicle's latest reading — for the per-vehicle detail card. Returns
// { telematics: null } when the vehicle isn't linked to any provider.
router.get('/fleet/telematics/vehicle/:id', requireStaff, async (req, res, next) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (!Number.isInteger(id)) return res.status(400).json({ message: 'invalid id' });
    const row = await queryOne(`${TELEMETRY_SELECT} WHERE v.id = $1`, [id]);
    res.json({ telematics: (row && row.source) ? row : null });
  } catch (e) { next(e); }
});

module.exports = router;
