// routes/fleet-smartcar.js
// Smartcar V3 (Connect 2.0) integration. Mounted at /api/fleet by server.js.
//
// V3 architecture:
//   1. Admin clicks "Connect via Smartcar" → frontend GET /smartcar/connect-url
//      → response is a Smartcar Connect URL with application_id, redirect_uri,
//        signed state JWT.
//   2. Admin authorizes Ford / OEM account → Smartcar redirects to our
//      callback with ?code=&state=.
//   3. Callback verifies state, exchanges the code at iam.smartcar.com to
//      finalize the connection, then lists /v3/connections with the M2M
//      token to find the new link by VIN. Stores sc_vehicle_id + sc_user_id
//      in vehicle_smartcar_links (no per-user OAuth tokens in V3).
//   4. Location: GET /vehicles/:id/location → fetch M2M token (cached),
//      call /v3/vehicles/{sc_vehicle_id}/signals/location-preciselocation
//      with sc-user-id header. Snapshot rowed for audit + history.
//   5. Disconnect: POST /vehicles/:id/smartcar/disconnect → wipes the
//      local link row. (V3 has no public revoke endpoint; the user must
//      remove the app from their Ford/OEM account if they want to fully
//      cut access — usually fine since the M2M model means the link
//      stops working once removed locally.)

'use strict';

const express = require('express');
const { queryOne, query } = require('../db/connection');
const { requireStaff } = require('../middleware/auth');
const sc = require('../lib/smartcar-client');
const { validateVin } = require('../lib/vin');

const router = express.Router();

const PUBLIC_SHOP_URL = process.env.PUBLIC_SHOP_URL || 'https://holmgraphics.ca';

function ensureEnvReady(res) {
  if (!sc.isConfigured()) {
    res.status(503).json({ message: 'Smartcar is not configured on the server (missing env vars).' });
    return false;
  }
  return true;
}

// In-memory location cache so a page refresh doesn't fire repeat Smartcar
// calls. Keyed by vehicle_id → { result, expiresAt }. Resets on restart.
const LOCATION_TTL_MS = 60 * 1000;
const locationCache = new Map();
function cacheGet(id) {
  const hit = locationCache.get(id);
  if (!hit) return null;
  if (Date.now() > hit.expiresAt) { locationCache.delete(id); return null; }
  return hit.result;
}
function cacheSet(id, result) {
  locationCache.set(id, { result, expiresAt: Date.now() + LOCATION_TTL_MS });
}

function normVin(v) { return (v || '').replace(/\s+/g, '').toUpperCase(); }

// ─── GET /smartcar/status ────────────────────────────────────────────────────

router.get('/smartcar/status', requireStaff, async (req, res, next) => {
  try {
    const connected = await queryOne(
      `SELECT COUNT(*)::int AS n FROM vehicle_smartcar_links WHERE status = 'active'`
    );
    res.json({
      configured: sc.isConfigured(),
      mode:       sc.getMode(),
      connected:  connected.n,
      cap:        sc.getMaxVehicles()
    });
  } catch (err) { next(err); }
});

// ─── GET /smartcar/connect-url?vehicle_id=N ─────────────────────────────────

router.get('/smartcar/connect-url', requireStaff, async (req, res, next) => {
  try {
    if (!ensureEnvReady(res)) return;
    const vehicleId = parseInt(req.query.vehicle_id, 10);
    if (!Number.isInteger(vehicleId) || vehicleId <= 0) {
      return res.status(400).json({ message: 'vehicle_id required' });
    }
    const vehicle = await queryOne(`SELECT id, vin, type FROM vehicles WHERE id = $1`, [vehicleId]);
    if (!vehicle)               return res.status(404).json({ message: 'vehicle not found' });
    if (vehicle.type !== 'truck') return res.status(400).json({ message: 'Only trucks can be connected — trailers have no modem.' });
    if (!vehicle.vin)           return res.status(400).json({ message: 'Vehicle is missing a VIN. Add the VIN before connecting.' });
    const v = validateVin(vehicle.vin);
    if (!v.valid) return res.status(400).json({ message: `VIN looks wrong: ${v.reason} Fix it on the vehicle's Edit page before connecting Smartcar.` });

    const counts = await queryOne(`SELECT COUNT(*)::int AS n FROM vehicle_smartcar_links WHERE status = 'active'`);
    if (counts.n >= sc.getMaxVehicles()) {
      const alreadyLinked = await queryOne(`SELECT id FROM vehicle_smartcar_links WHERE vehicle_id = $1 AND status = 'active'`, [vehicleId]);
      if (!alreadyLinked) {
        return res.status(409).json({ message: `Smartcar cap reached (${sc.getMaxVehicles()}). Disconnect a vehicle before connecting another.` });
      }
    }

    const { url } = sc.getAuthUrl({ userId: req.user.id, vehicleId });
    res.json({ url, mode: sc.getMode() });
  } catch (err) { next(err); }
});

// ─── GET /smartcar/callback ─────────────────────────────────────────────────
// Browser-facing redirect target. Returns HTML redirects, not JSON.
//
// V3 flow:
//   a. Verify state JWT (CSRF)
//   b. Exchange the auth code at iam.smartcar.com — this finalizes the
//      connection on Smartcar's side. We don't actually need the tokens
//      it returns (V3 uses M2M for data fetches) but the exchange itself
//      is what makes the connection visible in /v3/connections.
//   c. List /v3/connections with the M2M token, find the connection whose
//      VIN matches the vehicle being connected. Capture sc_vehicle_id +
//      sc_user_id.
//   d. Upsert the link row.

router.get('/smartcar/callback', async (req, res) => {
  if (!sc.isConfigured()) {
    return res.status(503).send('Smartcar is not configured on the server.');
  }

  if (req.query.error) {
    return res.redirect(`${PUBLIC_SHOP_URL}/fleet-admin?smartcar_error=${encodeURIComponent(String(req.query.error_description || req.query.error))}`);
  }

  let payload;
  try {
    payload = sc.verifyState(req.query.state);
  } catch (e) {
    return res.redirect(`${PUBLIC_SHOP_URL}/fleet-admin?smartcar_error=${encodeURIComponent('Invalid or expired state token. Try connecting again from the vehicle page.')}`);
  }

  const code = req.query.code;
  if (!code) {
    return res.redirect(`${PUBLIC_SHOP_URL}/fleet-admin?smartcar_error=${encodeURIComponent('Missing code on callback.')}`);
  }

  const vehicleId = parseInt(payload.vid, 10);
  const adminId   = parseInt(payload.sub, 10);

  try {
    const vehicle = await queryOne(`SELECT id, vin FROM vehicles WHERE id = $1`, [vehicleId]);
    if (!vehicle) throw new Error('Vehicle no longer exists.');
    const targetVin = normVin(vehicle.vin);
    if (!targetVin) throw new Error('Vehicle has no VIN on file.');

    // (b) Finalize the connection. The response shape isn't strictly
    // documented — we log it for diagnostics but rely on (c) for the data.
    let exchangeResult;
    try {
      exchangeResult = await sc.exchangeCode(code);
    } catch (e) {
      // The exchange CAN error (single-use code, slow network) without
      // the connection being fully lost. Try (c) anyway; if no matching
      // connection appears, surface the exchange error.
      console.warn('[smartcar callback] code exchange threw:', e.message);
    }

    // (c) Find the newly-linked connection by VIN.
    const connections = await sc.listConnections({ pageSize: 200 });
    const match = connections.find((c) => normVin(c.vin) === targetVin);
    if (!match) {
      const got = connections.map((c) => c.vin).filter(Boolean).join(', ') || '(none)';
      const exchangeNote = exchangeResult ? '' : ' Code exchange may have failed — retry the Connect button.';
      throw new Error(`Smartcar didn't return a connection for VIN ${vehicle.vin}. Authorized VINs: ${got}.${exchangeNote}`);
    }

    const scVehicleId = match.id || match.vehicleId || match.vehicle_id;
    const scUserId    = match.userId || match.user_id || match.sc_user_id;
    if (!scVehicleId || !scUserId) {
      throw new Error(`Smartcar connection is missing id/userId fields: ${JSON.stringify(match)}`);
    }

    await query(
      `INSERT INTO vehicle_smartcar_links
         (vehicle_id, smartcar_vehicle_id, sc_user_id,
          access_token, refresh_token, token_expires_at,
          connected_by, status)
       VALUES ($1, $2, $3, NULL, NULL, NULL, $4, 'active')
       ON CONFLICT (vehicle_id) DO UPDATE SET
         smartcar_vehicle_id = EXCLUDED.smartcar_vehicle_id,
         sc_user_id          = EXCLUDED.sc_user_id,
         access_token        = NULL,
         refresh_token       = NULL,
         token_expires_at    = NULL,
         connected_by        = EXCLUDED.connected_by,
         connected_at        = NOW(),
         status              = 'active',
         last_error          = NULL`,
      [vehicleId, String(scVehicleId), String(scUserId), adminId]
    );

    return res.redirect(`${PUBLIC_SHOP_URL}/fleet-admin/vehicles/${vehicleId}?smartcar=connected`);
  } catch (e) {
    console.warn('[smartcar callback] failed:', e.message);
    return res.redirect(`${PUBLIC_SHOP_URL}/fleet-admin/vehicles/${vehicleId}?smartcar_error=${encodeURIComponent(e.message)}`);
  }
});

// ─── GET /vehicles/:id/smartcar ─────────────────────────────────────────────

router.get('/vehicles/:id/smartcar', requireStaff, async (req, res, next) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ message: 'invalid id' });
    const link = await queryOne(
      `SELECT l.id, l.smartcar_vehicle_id, l.sc_user_id, l.connected_at, l.last_synced_at,
              l.status, l.last_error,
              (e.first_name || ' ' || e.last_name) AS connected_by_name
         FROM vehicle_smartcar_links l
         LEFT JOIN employees e ON e.id = l.connected_by
        WHERE l.vehicle_id = $1`,
      [id]
    );
    res.json({
      configured: sc.isConfigured(),
      mode:       sc.getMode(),
      linked:     !!link,
      link:       link || null
    });
  } catch (err) { next(err); }
});

// ─── POST /vehicles/:id/smartcar/disconnect ─────────────────────────────────

router.post('/vehicles/:id/smartcar/disconnect', requireStaff, async (req, res, next) => {
  try {
    if (!ensureEnvReady(res)) return;
    const id = parseInt(req.params.id, 10);
    const link = await queryOne(
      `SELECT id FROM vehicle_smartcar_links WHERE vehicle_id = $1`,
      [id]
    );
    if (!link) return res.status(404).json({ message: 'no smartcar link for this vehicle' });

    // V3 doesn't expose a per-link revoke endpoint via the M2M API. The
    // user can disconnect at the OEM-account level (FordPass etc.) if
    // they want a hard revoke; for this app's purposes, removing the
    // local row stops all reads.
    await query(`DELETE FROM vehicle_smartcar_links WHERE id = $1`, [link.id]);
    locationCache.delete(id);
    res.json({ ok: true });
  } catch (err) { next(err); }
});

// ─── GET /vehicles/:id/location ─────────────────────────────────────────────

router.get('/vehicles/:id/location', requireStaff, async (req, res, next) => {
  try {
    if (!ensureEnvReady(res)) return;
    const id = parseInt(req.params.id, 10);
    if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ message: 'invalid id' });

    const refresh = req.query.refresh === '1' || req.query.refresh === 'true';
    if (!refresh) {
      const cached = cacheGet(id);
      if (cached) return res.json({ ...cached, cached: true });
    }

    const link = await queryOne(
      `SELECT id, smartcar_vehicle_id, sc_user_id, status
         FROM vehicle_smartcar_links WHERE vehicle_id = $1`,
      [id]
    );
    if (!link) return res.status(404).json({ message: 'vehicle is not connected to Smartcar' });
    if (link.status === 'revoked') return res.status(409).json({ message: 'this Smartcar link has been revoked — reconnect from the admin page' });
    if (!link.sc_user_id) return res.status(409).json({ message: 'this link predates V3 migration — disconnect and reconnect to refresh' });

    let location;
    try {
      location = await sc.fetchLocation({
        scVehicleId: link.smartcar_vehicle_id,
        scUserId:    link.sc_user_id
      });
    } catch (e) {
      await query(`UPDATE vehicle_smartcar_links SET status='error', last_error=$1 WHERE id=$2`, [e.message.slice(0, 500), link.id]);
      return res.status(502).json({ message: 'Smartcar fetch failed', detail: e.message });
    }

    // Defensive parsing — the V3 signal response shape isn't fully
    // pinned down. Try a few common paths.
    const d   = location?.data || location;
    const lat = Number(d?.latitude);
    const lng = Number(d?.longitude);
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
      await query(`UPDATE vehicle_smartcar_links SET status='error', last_error=$1 WHERE id=$2`,
        [`Could not extract lat/lng from response: ${JSON.stringify(location).slice(0,400)}`, link.id]);
      return res.status(502).json({ message: 'Smartcar returned location without valid coordinates' });
    }
    const scTs = location?.meta?.timestamp ? new Date(location.meta.timestamp) :
                 location?.meta?.dataAge   ? new Date(location.meta.dataAge)   :
                 null;

    // Snapshot row (audit + history). V3's PreciseLocation signal doesn't
    // include odometer / fuel — those would be separate signal endpoints,
    // wired later if needed.
    const ins = await queryOne(
      `INSERT INTO vehicle_location_snapshots
         (vehicle_id, latitude, longitude, odometer_km, fuel_percent_remaining, smartcar_timestamp, fetched_by)
       VALUES ($1, $2, $3, NULL, NULL, $4, $5)
       RETURNING id, fetched_at`,
      [id, lat, lng, scTs, req.user.id]
    );

    await query(`UPDATE vehicle_smartcar_links SET last_synced_at = NOW(), status='active', last_error=NULL WHERE id = $1`, [link.id]);

    const result = {
      vehicle_id:        id,
      latitude:          lat,
      longitude:         lng,
      odometer_km:       null,
      fuel_percent:      null,
      smartcar_timestamp: scTs,
      fetched_at:        ins.fetched_at,
      snapshot_id:       ins.id,
      cached:            false
    };
    cacheSet(id, result);
    res.json(result);
  } catch (err) { next(err); }
});

// ─── GET /vehicles/:id/locations  — recent history ──────────────────────────

router.get('/vehicles/:id/locations', requireStaff, async (req, res, next) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ message: 'invalid id' });
    const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 50, 1), 500);
    const rows = await query(
      `SELECT id, latitude, longitude, odometer_km, fuel_percent_remaining,
              smartcar_timestamp, fetched_at, fetched_by
         FROM vehicle_location_snapshots
        WHERE vehicle_id = $1
        ORDER BY fetched_at DESC
        LIMIT $2`,
      [id, limit]
    );
    res.json({ snapshots: rows });
  } catch (err) { next(err); }
});

module.exports = router;
