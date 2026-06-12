// routes/fleet-fordconnect.js
// FordConnect telematics endpoints (migration 048). Mirrors the
// fleet-smartcar.js shape so the UI can render both side-by-side.
//
// Flow:
//   GET  /api/fleet/fordconnect/status          → is_configured + current_link
//   GET  /api/fleet/fordconnect/authorize       → redirects to Ford OAuth
//   GET  /api/fleet/fordconnect/callback        → Ford redirects here w/ code
//   POST /api/fleet/fordconnect/sync            → pulls garage + telemetry
//   DELETE /api/fleet/fordconnect/unlink        → wipe tokens
//   GET  /api/fleet/fordconnect/vehicles        → linked Ford vehicles
//                                                  (cached telemetry)
//
// CSRF for the OAuth redirect uses a signed state cookie pattern: we
// stash a random nonce in a short-lived HttpOnly cookie before bouncing
// the user to Ford, then verify it on /callback.

'use strict';

const crypto = require('crypto');
const express = require('express');
const { query, queryOne } = require('../db/connection');
const { requireStaff } = require('../middleware/auth');
const ford = require('../lib/fordconnect');

const router = express.Router();
router.use(express.json());

const STATE_COOKIE = 'fc_oauth_state';
const STATE_TTL_S  = 600;   // 10 min — enough for the user to log into FordPass

// ─── Status / link metadata ────────────────────────────────────────────
router.get('/fleet/fordconnect/status', requireStaff, async (req, res, next) => {
  try {
    const configured = ford.isConfigured();
    const link = await queryOne(
      `SELECT id, employee_id,
              expires_at, scope, last_status, last_synced_at,
              created_at, updated_at,
              (expires_at < NOW()) AS expired,
              (SELECT COUNT(*) FROM fordconnect_vehicles WHERE link_id = l.id) AS vehicle_count
         FROM fordconnect_links l
        ORDER BY id DESC
        LIMIT 1`
    );
    res.json({ configured, linked: Boolean(link), link });
  } catch (e) { next(e); }
});

// ─── OAuth initiation — redirect to Ford ───────────────────────────────
router.get('/fleet/fordconnect/authorize', requireStaff, (req, res, next) => {
  try {
    if (!ford.isConfigured()) {
      return res.status(503).json({ message: 'FordConnect not configured on the server.' });
    }
    const state = crypto.randomBytes(32).toString('base64url');
    res.cookie(STATE_COOKIE, state, {
      httpOnly: true,
      secure:   process.env.NODE_ENV !== 'development',
      sameSite: 'lax',
      maxAge:   STATE_TTL_S * 1000,
    });
    res.redirect(ford.authorizeUrl({ state }));
  } catch (e) { next(e); }
});

// ─── OAuth callback — Ford lands here with ?code=…&state=… ─────────────
router.get('/fleet/fordconnect/callback', async (req, res, next) => {
  try {
    const { code, state, error, error_description } = req.query || {};
    if (error) {
      return res.status(400).send(`FordConnect authorization failed: ${error_description || error}`);
    }
    const cookieState = req.cookies?.[STATE_COOKIE] || '';
    if (!state || !cookieState || state !== cookieState) {
      return res.status(400).send('FordConnect callback: invalid state (CSRF check failed).');
    }
    res.clearCookie(STATE_COOKIE);
    if (!code) return res.status(400).send('FordConnect callback: missing code.');

    const tok = await ford.exchangeCode(code);
    const expiresAt = new Date(Date.now() + (Number(tok.expires_in) || 3600) * 1000);

    // Replace any prior link — one shop, one FordPass owner. Cleaner than
    // multi-link logic at this scale.
    await query(`DELETE FROM fordconnect_links`);
    await queryOne(
      `INSERT INTO fordconnect_links
         (employee_id, access_token, refresh_token, expires_at, scope, last_status, last_synced_at)
       VALUES ($1, $2, $3, $4, $5, 'Connected — sync pending', NULL)
       RETURNING id`,
      [req.user?.id || null, tok.access_token, tok.refresh_token, expiresAt, tok.scope || null]
    );
    // Redirect the staffer back into the fleet UI.
    res.redirect('/fleet-admin?fordconnect=linked');
  } catch (e) { next(e); }
});

// ─── Token-fresh helper — used by sync ─────────────────────────────────
async function getFreshAccessToken(link) {
  // 60s safety margin so a token doesn't expire mid-request.
  if (new Date(link.expires_at).getTime() - Date.now() > 60_000) {
    return link.access_token;
  }
  const tok = await ford.refreshTokens(link.refresh_token);
  const expiresAt = new Date(Date.now() + (Number(tok.expires_in) || 3600) * 1000);
  await query(
    `UPDATE fordconnect_links
        SET access_token = $1, refresh_token = $2, expires_at = $3, scope = $4
      WHERE id = $5`,
    [tok.access_token, tok.refresh_token, expiresAt, tok.scope || link.scope, link.id]
  );
  return tok.access_token;
}

// ─── Sync — pull /garage + /telemetry, update DB ───────────────────────
router.post('/fleet/fordconnect/sync', requireStaff, async (req, res, next) => {
  try {
    const link = await queryOne(`SELECT * FROM fordconnect_links ORDER BY id DESC LIMIT 1`);
    if (!link) return res.status(400).json({ message: 'No FordConnect link. Authorize first.' });

    const tok = await getFreshAccessToken(link);

    // 1. /garage gives us the VIN list and basic vehicle info.
    const garage = await ford.getGarage(tok);
    const vehicles = Array.isArray(garage?.vehicles) ? garage.vehicles
                   : Array.isArray(garage)           ? garage
                   : [];

    // 2. /telemetry returns a single snapshot per linked vehicle in one
    // call (Ford's docs aren't crystal but the v1 endpoint is bulk).
    let telemetry = null;
    try { telemetry = await ford.getTelemetry(tok); }
    catch (e) { console.warn('[fordconnect] telemetry fetch failed:', e.message); }
    const tArr = Array.isArray(telemetry?.vehicles) ? telemetry.vehicles
               : Array.isArray(telemetry)           ? telemetry
               : [];
    const byVin = new Map();
    for (const t of tArr) {
      const v = (t.vin || t.vehicleId || '').toUpperCase();
      if (v) byVin.set(v, t);
    }

    let upserted = 0;
    for (const v of vehicles) {
      const vin = (v.vin || v.vehicleId || '').toUpperCase();
      if (!vin) continue;
      const t = byVin.get(vin) || {};
      // Try to auto-link to our fleet by VIN match.
      const ours = await queryOne(`SELECT id FROM vehicles WHERE UPPER(vin) = $1 LIMIT 1`, [vin]);
      await query(
        `INSERT INTO fordconnect_vehicles
           (link_id, vehicle_id, ford_vin, ford_nickname, make, model, year,
            last_location_lat, last_location_lon, last_location_at,
            last_odometer_km, last_odometer_at, last_fuel_pct,
            last_fetched_at, last_fetch_error)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,NOW(),NULL)
         ON CONFLICT (link_id, ford_vin) DO UPDATE SET
           vehicle_id        = COALESCE(fordconnect_vehicles.vehicle_id, EXCLUDED.vehicle_id),
           ford_nickname     = EXCLUDED.ford_nickname,
           make              = COALESCE(EXCLUDED.make,  fordconnect_vehicles.make),
           model             = COALESCE(EXCLUDED.model, fordconnect_vehicles.model),
           year              = COALESCE(EXCLUDED.year,  fordconnect_vehicles.year),
           last_location_lat = COALESCE(EXCLUDED.last_location_lat, fordconnect_vehicles.last_location_lat),
           last_location_lon = COALESCE(EXCLUDED.last_location_lon, fordconnect_vehicles.last_location_lon),
           last_location_at  = COALESCE(EXCLUDED.last_location_at,  fordconnect_vehicles.last_location_at),
           last_odometer_km  = COALESCE(EXCLUDED.last_odometer_km,  fordconnect_vehicles.last_odometer_km),
           last_odometer_at  = COALESCE(EXCLUDED.last_odometer_at,  fordconnect_vehicles.last_odometer_at),
           last_fuel_pct     = COALESCE(EXCLUDED.last_fuel_pct,     fordconnect_vehicles.last_fuel_pct),
           last_fetched_at   = NOW(),
           last_fetch_error  = NULL`,
        [
          link.id, ours?.id || null, vin,
          v.nickName || v.nickname || null,
          v.make || null, v.modelName || v.model || null,
          v.modelYear ? parseInt(v.modelYear, 10) : (v.year || null),
          t.location?.latitude  ?? t.position?.latitude  ?? null,
          t.location?.longitude ?? t.position?.longitude ?? null,
          (t.location?.timestamp || t.position?.timestamp) || null,
          t.odometer?.value ?? t.odometer ?? null,
          t.odometer?.timestamp || null,
          t.fuel?.fuelLevel ?? t.fuelLevel ?? null,
        ]
      );
      upserted++;
    }

    await query(
      `UPDATE fordconnect_links
          SET last_status = $1, last_synced_at = NOW()
        WHERE id = $2`,
      [`Synced ${upserted} vehicle${upserted === 1 ? '' : 's'}`, link.id]
    );

    res.json({ ok: true, synced: upserted });
  } catch (e) {
    // Record sync failures on the link so the UI can surface them.
    try {
      await query(
        `UPDATE fordconnect_links SET last_status = $1 WHERE id =
           (SELECT id FROM fordconnect_links ORDER BY id DESC LIMIT 1)`,
        [`Sync failed: ${e.message || String(e)}`.slice(0, 500)]
      );
    } catch { /* best-effort */ }
    next(e);
  }
});

// ─── List linked Ford vehicles with cached telemetry ───────────────────
router.get('/fleet/fordconnect/vehicles', requireStaff, async (req, res, next) => {
  try {
    const rows = await query(
      `SELECT fv.id, fv.link_id, fv.vehicle_id, fv.ford_vin,
              fv.ford_nickname, fv.make, fv.model, fv.year,
              fv.last_location_lat, fv.last_location_lon, fv.last_location_at,
              fv.last_odometer_km,  fv.last_odometer_at,
              fv.last_fuel_pct,
              fv.last_fetched_at, fv.last_fetch_error,
              v.unit_number,
              v.year  AS our_year, v.make AS our_make, v.model AS our_model
         FROM fordconnect_vehicles fv
         LEFT JOIN vehicles v ON v.id = fv.vehicle_id
        ORDER BY v.unit_number NULLS LAST, fv.ford_nickname`
    );
    res.json({ vehicles: rows });
  } catch (e) { next(e); }
});

// ─── Unlink — clear tokens + cached vehicles ───────────────────────────
router.delete('/fleet/fordconnect/unlink', requireStaff, async (req, res, next) => {
  try {
    await query(`DELETE FROM fordconnect_links`);
    res.status(204).end();
  } catch (e) { next(e); }
});

module.exports = router;
