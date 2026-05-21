// routes/fleet-smartcar.js
// Phase 2 of the fleet portal — Smartcar telematics endpoints. Mounted at
// /api/fleet/smartcar + /api/fleet/vehicles/:id/location by server.js.
//
// Flow:
//   1. Admin clicks "Connect via Smartcar" on a vehicle.
//      Frontend → GET /smartcar/connect-url?vehicle_id=N
//      Returns { url } pointing at Smartcar's OAuth dialog (state JWT
//      already embedded). Admin's browser is redirected there.
//   2. After authorizing the OEM account (FordPass / etc.):
//      Smartcar → GET /smartcar/callback?code=...&state=...
//      We verify state, exchange code for tokens, look up the VIN from
//      Smartcar, find the matching row in `vehicles`, store encrypted
//      tokens, redirect back to the admin UI.
//   3. Disconnect: POST /vehicles/:id/smartcar/disconnect — revokes
//      Smartcar's grant and deletes the link row.
//   4. Location: GET /vehicles/:id/location — refreshes token if needed,
//      calls Smartcar, writes a snapshot, returns coordinates. 60s
//      per-vehicle in-memory cache to respect rate limits.

'use strict';

const express = require('express');
const { queryOne, query, pool } = require('../db/connection');
const { requireStaff, requireAdmin } = require('../middleware/auth');
const sc = require('../lib/smartcar-client');
const { encrypt, decrypt, isConfigured: encConfigured } = require('../lib/encryption');
const { validateVin } = require('../lib/vin');

const router = express.Router();

// ─── helpers ────────────────────────────────────────────────────────────────

const PUBLIC_SHOP_URL = process.env.PUBLIC_SHOP_URL || 'https://holmgraphics.ca';

function ensureEnvReady(res) {
  if (!sc.isConfigured()) {
    res.status(503).json({ message: 'Smartcar is not configured on the server (missing env vars).' });
    return false;
  }
  if (!encConfigured()) {
    res.status(503).json({ message: 'Encryption is not configured on the server (missing ENCRYPTION_KEY).' });
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

async function decryptedTokens(link) {
  return {
    accessToken:  decrypt(link.access_token),
    refreshToken: decrypt(link.refresh_token)
  };
}

// Persist refreshed tokens back to the DB encrypted. Smartcar's exchangeRefreshToken
// also rotates the refresh token; both must be saved.
async function saveRefreshedTokens(linkId, tokens) {
  await query(
    `UPDATE vehicle_smartcar_links
        SET access_token     = $1,
            refresh_token    = $2,
            token_expires_at = $3,
            status           = 'active',
            last_error       = NULL
      WHERE id = $4`,
    [
      encrypt(tokens.accessToken),
      encrypt(tokens.refreshToken),
      tokens.expiration,
      linkId
    ]
  );
}

// ─── GET /smartcar/status  — for admin dashboards ───────────────────────────

router.get('/smartcar/status', requireStaff, async (req, res, next) => {
  try {
    const connected = await queryOne(
      `SELECT COUNT(*)::int AS n FROM vehicle_smartcar_links WHERE status = 'active'`
    );
    res.json({
      configured: sc.isConfigured() && encConfigured(),
      mode:       sc.getMode(),
      connected:  connected.n,
      cap:        sc.getMaxVehicles()
    });
  } catch (err) { next(err); }
});

// ─── GET /smartcar/connect-url?vehicle_id=N  — kicks off OAuth ──────────────

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

    // Hard cap on connected vehicles (cost guardrail).
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

// ─── GET /smartcar/callback  — OAuth redirect target ────────────────────────
// Note: this route is hit by the BROWSER (not as XHR), so it returns an HTML
// redirect on success/failure rather than JSON. It's still public — the JWT
// state token is the auth + CSRF.

router.get('/smartcar/callback', async (req, res) => {
  if (!sc.isConfigured() || !encConfigured()) {
    return res.status(503).send('Smartcar / encryption not configured on the server.');
  }

  // Smartcar can return error=... on cancel / failure
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

    const tokens = await sc.exchangeCode(code);

    // Smartcar returns the set of vehicles the user authorized — typically
    // one for FordPass single-vehicle accounts, sometimes more. We match by
    // VIN against the row the admin was connecting.
    const ids = await sc.listVehicles(tokens.accessToken);
    if (!ids || ids.length === 0) throw new Error('Smartcar returned no vehicles for this authorization.');

    let matchedSmartcarId = null;
    let matchedVin        = null;
    for (const sid of ids) {
      let vin;
      try { vin = await sc.getVehicleVin(sid, tokens.accessToken); } catch { continue; }
      if (vin && vehicle.vin && vin.replace(/\s+/g, '').toUpperCase() === vehicle.vin.replace(/\s+/g, '').toUpperCase()) {
        matchedSmartcarId = sid;
        matchedVin = vin;
        break;
      }
    }
    if (!matchedSmartcarId) {
      throw new Error(`The Smartcar account doesn't contain a vehicle with VIN ${vehicle.vin}. Make sure you authorized the right OEM account.`);
    }

    // Persist (upsert) the link row, encrypted.
    await query(
      `INSERT INTO vehicle_smartcar_links
         (vehicle_id, smartcar_vehicle_id, access_token, refresh_token, token_expires_at, connected_by, status)
       VALUES ($1, $2, $3, $4, $5, $6, 'active')
       ON CONFLICT (vehicle_id) DO UPDATE SET
         smartcar_vehicle_id = EXCLUDED.smartcar_vehicle_id,
         access_token        = EXCLUDED.access_token,
         refresh_token       = EXCLUDED.refresh_token,
         token_expires_at    = EXCLUDED.token_expires_at,
         connected_by        = EXCLUDED.connected_by,
         connected_at        = NOW(),
         status              = 'active',
         last_error          = NULL`,
      [
        vehicleId, matchedSmartcarId,
        encrypt(tokens.accessToken),
        encrypt(tokens.refreshToken),
        tokens.expiration,
        adminId
      ]
    );

    return res.redirect(`${PUBLIC_SHOP_URL}/fleet-admin/vehicles/${vehicleId}?smartcar=connected`);
  } catch (e) {
    console.warn('[smartcar callback] failed:', e.message);
    return res.redirect(`${PUBLIC_SHOP_URL}/fleet-admin/vehicles/${vehicleId}?smartcar_error=${encodeURIComponent(e.message)}`);
  }
});

// ─── GET /vehicles/:id/smartcar  — per-vehicle link status ──────────────────

router.get('/vehicles/:id/smartcar', requireStaff, async (req, res, next) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ message: 'invalid id' });
    const link = await queryOne(
      `SELECT l.id, l.smartcar_vehicle_id, l.connected_at, l.last_synced_at,
              l.token_expires_at, l.status, l.last_error,
              (e.first_name || ' ' || e.last_name) AS connected_by_name
         FROM vehicle_smartcar_links l
         LEFT JOIN employees e ON e.id = l.connected_by
        WHERE l.vehicle_id = $1`,
      [id]
    );
    res.json({
      configured: sc.isConfigured() && encConfigured(),
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
      `SELECT id, access_token, smartcar_vehicle_id FROM vehicle_smartcar_links WHERE vehicle_id = $1`,
      [id]
    );
    if (!link) return res.status(404).json({ message: 'no smartcar link for this vehicle' });

    // Best-effort revoke at Smartcar's side. Even if it fails, we wipe the
    // row locally — better to leak a token than to leave a dead link the
    // admin can't get rid of.
    try {
      const accessToken = decrypt(link.access_token);
      await sc.revoke(link.smartcar_vehicle_id, accessToken);
    } catch (e) {
      console.warn('[smartcar disconnect] revoke failed (proceeding with local delete):', e.message);
    }
    await query(`DELETE FROM vehicle_smartcar_links WHERE id = $1`, [link.id]);
    locationCache.delete(id);
    res.json({ ok: true });
  } catch (err) { next(err); }
});

// ─── GET /vehicles/:id/location  — on-demand fetch ──────────────────────────

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
      `SELECT id, smartcar_vehicle_id, access_token, refresh_token, token_expires_at, status
         FROM vehicle_smartcar_links WHERE vehicle_id = $1`,
      [id]
    );
    if (!link) return res.status(404).json({ message: 'vehicle is not connected to Smartcar' });
    if (link.status === 'revoked') return res.status(409).json({ message: 'this Smartcar link has been revoked — reconnect from the admin page' });

    let { accessToken, refreshToken } = await decryptedTokens(link);

    // Refresh if expired (or expiring in <60s).
    const expSoon = new Date(link.token_expires_at).getTime() - Date.now() < 60_000;
    if (expSoon) {
      try {
        const refreshed = await sc.refreshAccess(refreshToken);
        await saveRefreshedTokens(link.id, refreshed);
        accessToken = refreshed.accessToken;
      } catch (e) {
        await query(`UPDATE vehicle_smartcar_links SET status='error', last_error=$1 WHERE id=$2`, [e.message.slice(0, 500), link.id]);
        return res.status(502).json({ message: 'token refresh failed — reconnect required', detail: e.message });
      }
    }

    let location, odometer, fuel;
    try {
      location = await sc.getVehicleLocation(link.smartcar_vehicle_id, accessToken);
      odometer = await sc.getVehicleOdometer(link.smartcar_vehicle_id, accessToken);
      fuel     = await sc.getVehicleFuel(link.smartcar_vehicle_id, accessToken);
    } catch (e) {
      await query(`UPDATE vehicle_smartcar_links SET status='error', last_error=$1 WHERE id=$2`, [e.message.slice(0, 500), link.id]);
      return res.status(502).json({ message: 'Smartcar fetch failed', detail: e.message });
    }

    const lat = Number(location?.latitude ?? location?.data?.latitude);
    const lng = Number(location?.longitude ?? location?.data?.longitude);
    const scTs = location?.meta?.dataAge ? new Date(location.meta.dataAge) :
                 (location?.meta?.requestTimestamp ? new Date(location.meta.requestTimestamp) : null);

    // odometer.distance is in km when Smartcar mode is metric (the default)
    const odoKm = odometer?.distance != null ? Number(odometer.distance) : null;
    const fuelPct = fuel?.percentRemaining != null ? Number(fuel.percentRemaining) * 100 : null;

    // Write a snapshot (this IS our audit row — fetched_by + fetched_at).
    const ins = await queryOne(
      `INSERT INTO vehicle_location_snapshots
         (vehicle_id, latitude, longitude, odometer_km, fuel_percent_remaining, smartcar_timestamp, fetched_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING id, fetched_at`,
      [id, lat, lng, odoKm, fuelPct, scTs, req.user.id]
    );

    await query(`UPDATE vehicle_smartcar_links SET last_synced_at = NOW(), status='active', last_error=NULL WHERE id = $1`, [link.id]);

    const result = {
      vehicle_id:        id,
      latitude:          lat,
      longitude:         lng,
      odometer_km:       odoKm,
      fuel_percent:      fuelPct,
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
