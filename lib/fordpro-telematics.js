// lib/fordpro-telematics.js
// Ford Pro Telematics REST API (https://api.fordpro.com) client + poller.
//
// Unlike the old consumer FordConnect approach (Azure B2C, per-user
// authorization_code with a redirect URI — removed in migration 050), this is
// the fleet-grade machine-to-machine product: a single service account using
// the OAuth *client-credentials* grant. Ford Pro bearer tokens are short-lived
// (~5 min),
// so we cache one in memory per process and re-request when it's within 60s of
// expiry. No DB, no refresh tokens.
//
// Endpoint versions/paths and the token URL are env-overridable on purpose:
// Ford Pro's API is mid-standardization and the support email's versioning
// was internally inconsistent (said "build V2" but listed /v3 and /v5). Set
// the exact values from the Developer Portal without a code change if they
// differ from the defaults below.
//
// Required env (from the Ford Pro Developer Portal service account):
//   FORD_TELEMATICS_CLIENT_ID, FORD_TELEMATICS_CLIENT_SECRET
// Optional env (sensible defaults; token URL is derived as BASE_URL + /token):
//   FORD_TELEMATICS_BASE_URL, FORD_TELEMATICS_TOKEN_URL, FORD_TELEMATICS_VEHICLES_PATH,
//   FORD_TELEMATICS_STATUS_PATH, FORD_TELEMATICS_POLL_MINUTES

'use strict';

const { query, queryOne } = require('../db/connection');

const BASE_URL  = (process.env.FORD_TELEMATICS_BASE_URL || 'https://api.fordpro.com/vehicle-status-api').replace(/\/$/, '');
// Ford's token endpoint is BASE_URL + /token (confirmed in the V2 Authentication
// docs). Overridable, but you shouldn't need to set it.
const TOKEN_URL = process.env.FORD_TELEMATICS_TOKEN_URL || `${BASE_URL}/token`;
const CLIENT_ID     = process.env.FORD_TELEMATICS_CLIENT_ID     || '';
const CLIENT_SECRET = process.env.FORD_TELEMATICS_CLIENT_SECRET || '';
const VEHICLES_PATH = process.env.FORD_TELEMATICS_VEHICLES_PATH || '/v3/vehicles';
const STATUS_PATH   = process.env.FORD_TELEMATICS_STATUS_PATH   || '/v5/vehicles/:vehicleId/status';
const POLL_MINUTES  = Math.max(5, parseInt(process.env.FORD_TELEMATICS_POLL_MINUTES || '30', 10));

function isConfigured() {
  return Boolean(CLIENT_ID && CLIENT_SECRET);
}

// ─── In-memory token cache (5-min tokens; client-credentials, no refresh) ───
let _token = null;   // { access_token, expires_at(ms) }

async function getAccessToken() {
  if (!isConfigured()) {
    throw new Error('Ford Telematics not configured (need FORD_TELEMATICS_CLIENT_ID and FORD_TELEMATICS_CLIENT_SECRET)');
  }
  if (_token && _token.expires_at - Date.now() > 60_000) return _token.access_token;

  // Ford's /token endpoint is NOT standard OAuth: POST a form body with the
  // literal params `clientId` and `clientSecret` (camelCase, no grant_type,
  // no scope). Confirmed in the V2 Authentication docs.
  const r = await fetch(TOKEN_URL, {
    method:  'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Accept': 'application/json' },
    body:    new URLSearchParams({ clientId: CLIENT_ID, clientSecret: CLIENT_SECRET }).toString(),
  });
  const json = await r.json().catch(() => null);
  if (!r.ok || !json?.access_token) {
    const msg = json?.error_description || json?.error || json?.message || `HTTP ${r.status}`;
    throw new Error(`Ford Telematics token endpoint: ${msg}`);
  }
  // Ford documents a fixed ~5-min token lifetime, and its `expires_in` is an
  // unreliable value (the docs' example is an absolute ms timestamp, not a
  // duration), so don't trust it — cache for 4 min and re-request with margin.
  _token = { access_token: json.access_token, expires_at: Date.now() + 4 * 60 * 1000 };
  return _token.access_token;
}

async function apiGet(path) {
  const token = await getAccessToken();
  const r = await fetch(`${BASE_URL}${path}`, {
    headers: { 'Authorization': `Bearer ${token}`, 'Accept': 'application/json' },
  });
  const json = await r.json().catch(() => null);
  if (!r.ok) {
    const msg = json?.message || json?.error || `HTTP ${r.status}`;
    const err = new Error(`Ford Telematics ${path}: ${msg}`);
    err.status = r.status;
    throw err;
  }
  return json;
}

// GET /v3/vehicles → enrolled vehicles, each with a non-sensitive vehicleId.
// Tolerate the common envelope shapes (vehicles/data/items/results or a bare array).
async function listVehicles() {
  const data = await apiGet(VEHICLES_PATH);
  return Array.isArray(data)          ? data
       : Array.isArray(data?.vehicles) ? data.vehicles
       : Array.isArray(data?.data)     ? data.data
       : Array.isArray(data?.items)    ? data.items
       : Array.isArray(data?.results)  ? data.results
       : [];
}

// Raw passthrough for diagnostics — returns {status, ok, body} without throwing
// on non-2xx, so we can see exactly what Ford sends.
async function rawGet(path) {
  const token = await getAccessToken();
  const r = await fetch(`${BASE_URL}${path}`, {
    headers: { 'Authorization': `Bearer ${token}`, 'Accept': 'application/json' },
  });
  const txt = await r.text();
  let body; try { body = JSON.parse(txt); } catch { body = String(txt).slice(0, 2000); }
  return { status: r.status, ok: r.ok, body };
}

// GET /v5/vehicles/:vehicleId/status → current signals snapshot.
async function getVehicleStatus(vehicleId) {
  return apiGet(STATUS_PATH.replace(':vehicleId', encodeURIComponent(vehicleId)));
}

function num(v) { const n = Number(v); return Number.isFinite(n) ? n : null; }
function strOrNull(v) { return (v == null || v === '') ? null : String(v).slice(0, 40); }

// Normalize a /status payload into our snapshot columns. The exact JSON shape
// isn't pinned down yet (no sandbox; docs mid-standardization), so this
// tolerates the two shapes Ford Pro tends to return — an array of typed
// signals, or a flat object of signal groups — and returns nulls for anything
// missing. VERIFY against a real Developer Portal example payload and tighten.
function mapStatus(status) {
  const out = {
    lat: null, lon: null, location_at: null,
    odometer_km: null, odometer_at: null,
    fuel_pct: null, ignition: null, battery_volts: null,
    ev_soc_pct: null, ev_range_km: null,
  };
  if (!status || typeof status !== 'object') return out;

  // Shape A: array of typed signals ([{ type/signalType, value, timestamp }]).
  const signals = status.signals || status.vehicleStatus || status.data;
  if (Array.isArray(signals)) {
    for (const s of signals) {
      const type = String(s.type || s.signalType || s.name || '').toUpperCase();
      const val  = (s.value != null && typeof s.value === 'object') ? s.value : (s.value ?? s);
      const ts   = s.timestamp || s.updatedAt || null;
      if (type === 'POSITION' || type === 'LOCATION') {
        out.lat = num(val.latitude ?? val.lat); out.lon = num(val.longitude ?? val.lon ?? val.lng); out.location_at = ts;
      } else if (type === 'ODOMETER') {
        out.odometer_km = num(val.value ?? val.odometer ?? val); out.odometer_at = ts;
      } else if (type === 'FUEL' || type === 'FUEL_LEVEL' || type === 'FUELLEVEL') {
        out.fuel_pct = num(val.value ?? val.percentage ?? val.fuelLevel ?? val);
      } else if (type === 'IGNITION' || type === 'IGNITION_STATUS') {
        out.ignition = strOrNull(val.value ?? val.status ?? val);
      } else if (type === 'BATTERY' || type === 'BATTERY_VOLTAGE' || type === '12V_BATTERY') {
        out.battery_volts = num(val.value ?? val.voltage ?? val);
      } else if (type === 'EV_BATTERY_SOC' || type === 'XEV_BATTERY_STATE_OF_CHARGE' || type === 'STATE_OF_CHARGE') {
        out.ev_soc_pct = num(val.value ?? val);
      } else if (type === 'EV_RANGE' || type === 'XEV_BATTERY_RANGE') {
        out.ev_range_km = num(val.value ?? val);
      }
    }
    return out;
  }

  // Shape B: flat object of signal groups.
  const pos = status.position || status.location;
  if (pos) { out.lat = num(pos.latitude ?? pos.lat); out.lon = num(pos.longitude ?? pos.lon); out.location_at = pos.timestamp || null; }
  if (status.odometer != null) { out.odometer_km = num(status.odometer.value ?? status.odometer); out.odometer_at = status.odometer?.timestamp || null; }
  out.fuel_pct      = num(status.fuelLevel?.value ?? status.fuelLevel ?? status.fuel?.fuelLevel);
  out.ignition      = strOrNull(status.ignitionStatus?.value ?? status.ignitionStatus ?? status.ignition);
  out.battery_volts = num(status.batteryVoltage?.value ?? status.batteryVoltage ?? status.battery?.voltage);
  out.ev_soc_pct    = num(status.stateOfCharge?.value ?? status.evBatterySoc);
  out.ev_range_km   = num(status.evRange?.value ?? status.evBatteryRange);
  return out;
}

async function setPollState(statusText) {
  await query(
    `UPDATE fordpro_poll_state SET last_polled_at = NOW(), last_status = $1 WHERE id = 1`,
    [String(statusText).slice(0, 500)]
  ).catch(() => { /* best-effort */ });
}

// Pull the enrolled vehicle list, fetch each vehicle's status, and upsert the
// snapshot. Auto-links to our fleet.vehicles by VIN. Idempotent — safe for the
// poller and the manual /sync route. Returns a summary.
async function runFordproSync({ log = console.log } = {}) {
  if (!isConfigured()) {
    log('[fordpro] not configured — skipping poll');
    return { configured: false, synced: 0, errors: 0, total: 0 };
  }

  let vehicles;
  try {
    vehicles = await listVehicles();
  } catch (e) {
    const msg = e.message || String(e);
    log(`[fordpro] vehicle list failed: ${msg}`);
    await setPollState(`Vehicle list failed: ${msg}`);
    return { configured: true, synced: 0, errors: 1, total: 0 };
  }

  let synced = 0;
  let errors = 0;
  for (const v of vehicles) {
    const vehicleId = v.vehicleId || v.id;
    const vin = String(v.vin || '').toUpperCase();
    if (!vehicleId) continue;

    let mapped = mapStatus(null);   // all-null defaults
    let fetchError = null;
    try {
      mapped = mapStatus(await getVehicleStatus(vehicleId));
    } catch (e) {
      fetchError = (e.message || String(e)).slice(0, 500);
      errors++;
      log(`[fordpro] status fetch failed for ${vin || vehicleId}: ${fetchError}`);
    }

    // Auto-link to our fleet by VIN.
    const ours = vin
      ? await queryOne(`SELECT id FROM vehicles WHERE UPPER(vin) = $1 LIMIT 1`, [vin])
      : null;

    await query(
      `INSERT INTO fordpro_vehicles
         (ford_vehicle_id, ford_vin, vehicle_id, make, model, year,
          last_location_lat, last_location_lon, last_location_at,
          last_odometer_km, last_odometer_at, last_fuel_pct,
          last_ignition, last_battery_volts, last_ev_soc_pct, last_ev_range_km,
          last_fetched_at, last_fetch_error)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,NOW(),$17)
       ON CONFLICT (ford_vehicle_id) DO UPDATE SET
         ford_vin           = EXCLUDED.ford_vin,
         vehicle_id         = COALESCE(fordpro_vehicles.vehicle_id, EXCLUDED.vehicle_id),
         make               = COALESCE(EXCLUDED.make,  fordpro_vehicles.make),
         model              = COALESCE(EXCLUDED.model, fordpro_vehicles.model),
         year               = COALESCE(EXCLUDED.year,  fordpro_vehicles.year),
         last_location_lat  = COALESCE(EXCLUDED.last_location_lat,  fordpro_vehicles.last_location_lat),
         last_location_lon  = COALESCE(EXCLUDED.last_location_lon,  fordpro_vehicles.last_location_lon),
         last_location_at   = COALESCE(EXCLUDED.last_location_at,   fordpro_vehicles.last_location_at),
         last_odometer_km   = COALESCE(EXCLUDED.last_odometer_km,   fordpro_vehicles.last_odometer_km),
         last_odometer_at   = COALESCE(EXCLUDED.last_odometer_at,   fordpro_vehicles.last_odometer_at),
         last_fuel_pct      = COALESCE(EXCLUDED.last_fuel_pct,      fordpro_vehicles.last_fuel_pct),
         last_ignition      = COALESCE(EXCLUDED.last_ignition,      fordpro_vehicles.last_ignition),
         last_battery_volts = COALESCE(EXCLUDED.last_battery_volts, fordpro_vehicles.last_battery_volts),
         last_ev_soc_pct    = COALESCE(EXCLUDED.last_ev_soc_pct,    fordpro_vehicles.last_ev_soc_pct),
         last_ev_range_km   = COALESCE(EXCLUDED.last_ev_range_km,   fordpro_vehicles.last_ev_range_km),
         last_fetched_at    = NOW(),
         last_fetch_error   = EXCLUDED.last_fetch_error`,
      [
        String(vehicleId), vin || null, ours?.id || null,
        v.make || null, v.model || v.modelName || null,
        (v.year || v.modelYear) ? parseInt(v.year || v.modelYear, 10) : null,
        mapped.lat, mapped.lon, mapped.location_at,
        mapped.odometer_km, mapped.odometer_at, mapped.fuel_pct,
        mapped.ignition, mapped.battery_volts, mapped.ev_soc_pct, mapped.ev_range_km,
        fetchError,
      ]
    );
    if (!fetchError) synced++;
  }

  const summary = `Polled ${vehicles.length} vehicle${vehicles.length === 1 ? '' : 's'}, ${errors} error${errors === 1 ? '' : 's'}`;
  await setPollState(summary);
  log(`[fordpro] poll done — ${synced} ok, ${errors} errors of ${vehicles.length}`);
  return { configured: true, synced, errors, total: vehicles.length };
}

// Schedule once-per-process. Fires ~60s after boot, then every
// FORD_TELEMATICS_POLL_MINUTES. No-op (and logs) when not configured, so the
// service runs fine before the service-account creds are added to Railway.
function scheduleFordproPoll() {
  if (!isConfigured()) {
    console.log('[fordpro] not configured — poller not started (set FORD_TELEMATICS_* env to enable)');
    return;
  }
  const BOOT_DELAY_MS = 60 * 1000;
  const PERIOD_MS     = POLL_MINUTES * 60 * 1000;
  setTimeout(() => {
    runFordproSync().catch((e) => console.warn('[fordpro] poll threw:', e.message || e));
    setInterval(() => {
      runFordproSync().catch((e) => console.warn('[fordpro] poll threw:', e.message || e));
    }, PERIOD_MS);
  }, BOOT_DELAY_MS);
  console.log(`[fordpro] poller scheduled every ${POLL_MINUTES} min`);
}

module.exports = {
  isConfigured,
  getAccessToken,
  listVehicles,
  getVehicleStatus,
  rawGet,
  mapStatus,
  runFordproSync,
  scheduleFordproPoll,
  POLL_MINUTES,
};
