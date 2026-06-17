// routes/fleet-fordpro.js
// Ford Pro Telematics endpoints (migration 049). Machine-to-machine — a single
// service account (client credentials), so there's no per-user OAuth redirect
// flow. Telemetry refreshes on a server-side poller (lib/fordpro-telematics.js);
// these routes expose status, a manual refresh, and the cached snapshot.
//
//   GET  /api/fleet/fordpro/status     → configured + poll state + counts
//   POST /api/fleet/fordpro/sync       → poll Ford now (manual refresh)
//   GET  /api/fleet/fordpro/vehicles   → cached telemetry, joined to fleet

'use strict';

const express = require('express');
const { query, queryOne } = require('../db/connection');
const { requireStaff } = require('../middleware/auth');
const fordpro = require('../lib/fordpro-telematics');

const router = express.Router();
router.use(express.json());

// ─── Status / poll metadata ────────────────────────────────────────────
router.get('/fleet/fordpro/status', requireStaff, async (req, res, next) => {
  try {
    const state = await queryOne(
      `SELECT last_polled_at, last_status FROM fordpro_poll_state WHERE id = 1`
    );
    const counts = await queryOne(
      `SELECT COUNT(*)::int             AS vehicle_count,
              COUNT(vehicle_id)::int    AS linked_count
         FROM fordpro_vehicles`
    );
    res.json({
      configured:    fordpro.isConfigured(),
      poll_minutes:  fordpro.POLL_MINUTES,
      last_polled_at: state?.last_polled_at || null,
      last_status:    state?.last_status || null,
      vehicle_count: counts?.vehicle_count || 0,
      linked_count:  counts?.linked_count || 0,
    });
  } catch (e) { next(e); }
});

// ─── Manual refresh — poll Ford right now ──────────────────────────────
router.post('/fleet/fordpro/sync', requireStaff, async (req, res, next) => {
  try {
    if (!fordpro.isConfigured()) {
      return res.status(503).json({ message: 'Ford Telematics not configured on the server.' });
    }
    const result = await fordpro.runFordproSync();
    res.json({ ok: true, ...result });
  } catch (e) { next(e); }
});

// ─── List Ford Pro vehicles with cached telemetry ──────────────────────
router.get('/fleet/fordpro/vehicles', requireStaff, async (req, res, next) => {
  try {
    const rows = await query(
      `SELECT fp.id, fp.ford_vehicle_id, fp.ford_vin, fp.vehicle_id,
              fp.make, fp.model, fp.year,
              fp.last_location_lat, fp.last_location_lon, fp.last_location_at,
              fp.last_odometer_km,  fp.last_odometer_at, fp.last_fuel_pct,
              fp.last_ignition, fp.last_battery_volts,
              fp.last_ev_soc_pct, fp.last_ev_range_km,
              fp.last_fetched_at, fp.last_fetch_error,
              v.unit_number,
              v.year AS our_year, v.make AS our_make, v.model AS our_model
         FROM fordpro_vehicles fp
         LEFT JOIN vehicles v ON v.id = fp.vehicle_id
        ORDER BY v.unit_number NULLS LAST, fp.ford_vin`
    );
    res.json({ vehicles: rows });
  } catch (e) { next(e); }
});

// ─── Diagnostic: raw /v3/vehicles response (temporary) ─────────────────
// Returns exactly what Ford sends so we can confirm shape vs empty list.
// Remove once telemetry is confirmed flowing.
router.get('/fleet/fordpro/debug', requireStaff, async (req, res, next) => {
  try {
    const vehicles = await fordpro.rawGet('/v3/vehicles');
    res.json({ vehicles });
  } catch (e) {
    res.status(500).json({ error: e.message || String(e) });
  }
});

module.exports = router;
