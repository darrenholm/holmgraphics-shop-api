// routes/fleet-inspections.js
// Daily vehicle inspection ("circle check") — O. Reg. 199/07.
//
// Mounted at /api by server.js, BEFORE the generic /api/fleet router, so the
// specific /fleet/inspections/* paths win over /fleet/vehicles/:id. Same
// pattern as fleet-fordpro.js.
//
// What makes this different from the rest of the fleet API: a completed row
// in `inspections` is a legal record. The database enforces that with a
// trigger (migration 060) — this layer's job is to make sure the row is
// COMPLETE and TRUE before that trigger freezes it:
//
//   * Every legally-required field is snapshotted server-side at completion.
//     The client cannot supply carrier name, plate, inspector name, the
//     declaration wording, or completed_at. If a client could send those, a
//     signed report would be worth nothing in an audit.
//   * A major defect puts the unit out of service, and the unit stays out of
//     service until an ADMIN records a repair. A driver cannot clear it, and
//     cannot pass a later inspection while one is open.
//   * Telematics is a convenience, never a gate. Every prefill path degrades
//     to manual entry and the check still completes with Ford Pro down.
//
//   GET    /api/fleet/inspections/scope                  → admin/dashboard board
//   GET    /api/fleet/inspections/prefill                → everything to start a check
//   POST   /api/fleet/inspections                        → create or resume a draft
//   GET    /api/fleet/inspections                        → history, filterable
//   GET    /api/fleet/inspections/:id                    → one report, draft or signed
//   PATCH  /api/fleet/inspections/:id                    → save draft progress
//   POST   /api/fleet/inspections/:id/defects            → flag an item
//   PATCH  /api/fleet/inspections/:id/defects/:defectId  → edit a flagged item
//   DELETE /api/fleet/inspections/:id/defects/:defectId  → unflag (drafts only)
//   POST   /api/fleet/inspections/:id/defects/:defectId/photo → attach a photo
//   GET    /api/fleet/inspection-defects/:defectId/photo → stream a photo
//   POST   /api/fleet/inspections/:id/complete           → sign + freeze
//   GET    /api/fleet/inspection-defects/open            → admin open defect queue
//   POST   /api/fleet/inspection-defects/:defectId/resolve → admin records the repair
//   GET    /api/fleet/inspection-schedules               → schedules + items (offline carry)
//   POST   /api/fleet/inspection-schedules/:id/verify    → admin confirms official wording

'use strict';

const express = require('express');
const multer  = require('multer');
const { query, queryOne, pool } = require('../db/connection');
const { requireStaff, requireAdmin } = require('../middleware/auth');
const storage = require('../lib/fleet-storage');
const mailer  = require('../lib/customer-mailer');
const jobs    = require('../lib/inspection-jobs');

const router = express.Router();
router.use(express.json());

const upload = multer({
  storage: multer.memoryStorage(),
  limits:  { fileSize: storage.MAX_BYTES },
});

// The carrier name printed on every report. Snapshotted per-inspection, so
// changing this never rewrites a report that's already been signed.
const CARRIER_NAME = process.env.FLEET_CARRIER_NAME || 'HOLM GRAPHICS INC.';

// A telematics odometer older than this is offered as a suggestion the driver
// has to confirm rather than a value we assert. Two hours is the spec's
// number: long enough to cover a truck sitting overnight and reporting on
// wake, short enough that a stale reading can't quietly become the record.
const ODOMETER_FRESH_MS = 2 * 60 * 60 * 1000;

// Vehicle documents inside this window are called out to the driver.
const DOC_WARN_DAYS = 30;

// Bounds on a device clock arriving through the offline sync path. Generous
// backwards — a Friday-evening check synced Monday morning is ~60 h old and
// entirely legitimate. Tight forwards, because a report dated in the future
// is indefensible and always means a broken clock rather than a late sync.
const MAX_OFFLINE_AGE_MS  = 72 * 60 * 60 * 1000;
const MAX_CLOCK_AHEAD_MS  = 15 * 60 * 1000;

// ─── Who may perform an inspection ─────────────────────────────────────
// Open question 4 in the build spec is unresolved: all six staff, or a
// subset? Today this is requireStaff, i.e. anyone who can log in to the
// staff surface. When that's decided, narrow it HERE — one constant, one
// middleware — rather than sprinkling role checks through the handlers.
const requireInspector = requireStaff;

// ─── helpers ───────────────────────────────────────────────────────────

function intParam(v) {
  const n = Number.parseInt(v, 10);
  return Number.isInteger(n) && n > 0 ? n : null;
}

function badRequest(res, message, extra = {}) {
  return res.status(400).json({ message, ...extra });
}

// Days until a date, in whole days, relative to local midnight. Negative
// means already expired.
function daysUntil(dateVal) {
  if (!dateVal) return null;
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const d = new Date(dateVal); d.setHours(0, 0, 0, 0);
  return Math.floor((d.getTime() - today.getTime()) / 86400000);
}

// Expired / expiring documents for a unit, in the shape stored on
// inspections.warnings. Computed fresh at prefill AND again at completion —
// the driver could have sat on the check for an hour, and the record should
// reflect what was true when they signed.
async function documentWarnings(vehicleId) {
  const docs = await query(
    `SELECT doc_type, expiry_date
       FROM fleet_documents
      WHERE vehicle_id = $1 AND is_current = TRUE`,
    [vehicleId]
  );
  const out = [];
  for (const d of docs) {
    const days = daysUntil(d.expiry_date);
    if (days === null) continue;
    if (days < 0) {
      out.push({
        type: 'document_expired', severity: 'high', doc_type: d.doc_type,
        expiry_date: d.expiry_date,
        message: `${d.doc_type} expired ${Math.abs(days)} day${Math.abs(days) === 1 ? '' : 's'} ago`,
      });
    } else if (days <= DOC_WARN_DAYS) {
      out.push({
        type: 'document_expiring', severity: 'medium', doc_type: d.doc_type,
        expiry_date: d.expiry_date, days_remaining: days,
        message: `${d.doc_type} expires in ${days} day${days === 1 ? '' : 's'}`,
      });
    }
  }
  // An in-scope unit with no annual inspection document on file at all is
  // its own kind of gap, and it's the one an audit notices first.
  const types = new Set(docs.map((d) => d.doc_type));
  for (const required of ['insurance', 'inspection']) {
    if (!types.has(required)) {
      out.push({
        type: 'document_missing', severity: 'high', doc_type: required,
        message: `No current ${required} document on file for this unit`,
      });
    }
  }
  return out;
}

// Cached Ford Pro snapshot for a unit, if the VIN mapped to one.
async function telematicsFor(vehicleId) {
  return queryOne(
    `SELECT last_odometer_km, last_odometer_at,
            last_location_lat, last_location_lon, last_location_at,
            last_ignition, last_fetched_at, last_fetch_error
       FROM fordpro_vehicles
      WHERE vehicle_id = $1
      ORDER BY last_fetched_at DESC NULLS LAST
      LIMIT 1`,
    [vehicleId]
  );
}

// The odometer on the most recent SIGNED report for this unit. A new reading
// below this is a regression the driver has to acknowledge explicitly.
async function previousOdometer(vehicleId, excludeInspectionId = null) {
  return queryOne(
    `SELECT id, odometer_km, completed_at
       FROM inspections
      WHERE vehicle_id = $1
        AND completed_at IS NOT NULL
        AND deleted_at IS NULL
        AND status <> 'superseded'
        AND odometer_km IS NOT NULL
        AND ($2::int IS NULL OR id <> $2)
      ORDER BY completed_at DESC
      LIMIT 1`,
    [vehicleId, excludeInspectionId]
  );
}

// Defects still open on this unit, across every report. Used both to carry
// them forward onto a new draft and to decide whether the unit is allowed
// back into service.
async function openDefectsForVehicle(vehicleId) {
  return query(
    `SELECT d.id, d.severity, d.note, d.schedule_item_id, d.created_at,
            i.id AS inspection_id, i.completed_at AS reported_at,
            i.inspector_name AS reported_by,
            it.group_name, it.item_label, it.minor_defect_text, it.major_defect_text
       FROM inspection_defects d
       JOIN inspections i               ON i.id  = d.inspection_id
       JOIN inspection_schedule_items it ON it.id = d.schedule_item_id
      WHERE i.vehicle_id = $1
        AND i.deleted_at IS NULL
        AND i.completed_at IS NOT NULL
        AND d.resolved_at IS NULL
      ORDER BY d.severity DESC, d.created_at`,
    [vehicleId]
  );
}

async function loadInspection(id) {
  return queryOne(
    `SELECT i.*, v.unit_number, v.make, v.model, v.year, v.vin,
            s.name AS schedule_name, s.reg_reference, s.version AS schedule_version,
            s.source_verified AS schedule_source_verified
       FROM inspections i
       JOIN vehicles v            ON v.id = i.vehicle_id
       JOIN inspection_schedules s ON s.id = i.schedule_id
      WHERE i.id = $1 AND i.deleted_at IS NULL`,
    [id]
  );
}

async function loadDefects(inspectionId) {
  return query(
    `SELECT d.*, it.group_name, it.item_label,
            it.minor_defect_text, it.major_defect_text,
            e.first_name || ' ' || e.last_name AS resolved_by_name
       FROM inspection_defects d
       JOIN inspection_schedule_items it ON it.id = d.schedule_item_id
       LEFT JOIN employees e             ON e.id = d.resolved_by
      WHERE d.inspection_id = $1
      ORDER BY d.severity DESC, it.sort_order`,
    [inspectionId]
  );
}

// A draft may only be touched by the inspector who started it, and only
// while it is still a draft. Returns the row, or sends the error response
// and returns null.
async function requireOwnDraft(req, res, id) {
  const row = await loadInspection(id);
  if (!row) { res.status(404).json({ message: 'Inspection not found' }); return null; }
  if (row.completed_at) {
    res.status(409).json({
      message: 'This inspection is complete and cannot be changed. Start a new report that supersedes it.',
      code: 'inspection_immutable',
    });
    return null;
  }
  if (row.inspector_employee_id !== req.user.id) {
    res.status(403).json({ message: 'This check belongs to another inspector.' });
    return null;
  }
  return row;
}

// ═══════════════════════════════════════════════════════════════════════
// Board / scope
// ═══════════════════════════════════════════════════════════════════════

// Every unit the regulation applies to, with today's status. Feeds both
// /fleet-admin/inspections and the Fleet dashboard tile.
router.get('/fleet/inspections/scope', requireStaff, async (req, res, next) => {
  try {
    const rows = await query(
      `SELECT v.id, v.unit_number, v.type, v.make, v.model, v.year,
              v.license_plate, v.plate_jurisdiction,
              v.registered_gross_weight_kg, v.inspection_required,
              v.inspection_schedule_id,
              latest.id            AS latest_inspection_id,
              latest.completed_at  AS latest_completed_at,
              latest.valid_until   AS latest_valid_until,
              latest.status        AS latest_status,
              latest.inspector_name AS latest_inspector_name,
              latest.odometer_km   AS latest_odometer_km,
              COALESCE(od.open_major, 0) AS open_major_defects,
              COALESCE(od.open_minor, 0) AS open_minor_defects
         FROM vehicles v
         LEFT JOIN LATERAL (
           SELECT i.id, i.completed_at, i.valid_until, i.status,
                  i.inspector_name, i.odometer_km
             FROM inspections i
            WHERE i.vehicle_id = v.id
              AND i.completed_at IS NOT NULL
              AND i.deleted_at IS NULL
              AND i.status <> 'superseded'
            ORDER BY i.completed_at DESC
            LIMIT 1
         ) latest ON TRUE
         LEFT JOIN LATERAL (
           SELECT COUNT(*) FILTER (WHERE d.severity = 'major') AS open_major,
                  COUNT(*) FILTER (WHERE d.severity = 'minor') AS open_minor
             FROM inspection_defects d
             JOIN inspections i2 ON i2.id = d.inspection_id
            WHERE i2.vehicle_id = v.id
              AND i2.deleted_at IS NULL
              AND i2.completed_at IS NOT NULL
              AND d.resolved_at IS NULL
         ) od ON TRUE
        WHERE v.active = TRUE
        ORDER BY v.inspection_required DESC, v.unit_number`
    );

    const now = Date.now();
    const units = rows.map((r) => {
      const validUntil = r.latest_valid_until ? new Date(r.latest_valid_until).getTime() : null;
      const hasValid = validUntil !== null && validUntil > now && r.latest_status !== 'out_of_service';
      return {
        ...r,
        open_major_defects: Number(r.open_major_defects),
        open_minor_defects: Number(r.open_minor_defects),
        has_valid_inspection: hasValid,
        out_of_service: Number(r.open_major_defects) > 0,
        // A unit with no RGW on file is a gap, not a "no". The scope trigger
        // treats unknown as out-of-scope so nothing is silently asserted;
        // this surfaces it so it gets fixed. Trailers count too — Tr-03 is
        // the Skyjack trailer and whether it is in scope is decided by an
        // RGW nobody has read off the permit yet.
        rgw_unknown: r.registered_gross_weight_kg === null,
      };
    });

    const inScope = units.filter((u) => u.inspection_required);
    res.json({
      carrier_name: CARRIER_NAME,
      units,
      summary: {
        in_scope:       inScope.length,
        checked_today:  inScope.filter((u) => u.has_valid_inspection).length,
        overdue:        inScope.filter((u) => !u.has_valid_inspection).length,
        out_of_service: units.filter((u) => u.out_of_service).length,
        rgw_unknown:    units.filter((u) => u.rgw_unknown).length,
      },
    });
  } catch (e) { next(e); }
});

// ═══════════════════════════════════════════════════════════════════════
// Prefill — what the driver should never have to type
// ═══════════════════════════════════════════════════════════════════════

router.get('/fleet/inspections/prefill', requireInspector, async (req, res, next) => {
  try {
    let vehicleId = intParam(req.query.vehicle_id);

    // No unit given: fall back to the last one this inspector checked, so a
    // driver who always takes the same truck taps through without choosing.
    if (!vehicleId) {
      const last = await queryOne(
        `SELECT vehicle_id FROM inspections
          WHERE inspector_employee_id = $1 AND deleted_at IS NULL
          ORDER BY COALESCE(completed_at, started_at) DESC
          LIMIT 1`,
        [req.user.id]
      );
      vehicleId = last?.vehicle_id || null;
    }
    if (!vehicleId) {
      return res.json({ vehicle: null, needs_vehicle_choice: true, carrier_name: CARRIER_NAME });
    }

    const vehicle = await queryOne(
      `SELECT v.*, s.id AS schedule_id, s.name AS schedule_name,
              s.reg_reference, s.version AS schedule_version,
              s.declaration_text, s.source_verified AS schedule_source_verified
         FROM vehicles v
         LEFT JOIN inspection_schedules s ON s.id = v.inspection_schedule_id
        WHERE v.id = $1`,
      [vehicleId]
    );
    if (!vehicle) return res.status(404).json({ message: 'Vehicle not found' });

    const [tel, prev, carried, docWarnings, existingDraft] = await Promise.all([
      telematicsFor(vehicleId),
      previousOdometer(vehicleId),
      openDefectsForVehicle(vehicleId),
      documentWarnings(vehicleId),
      queryOne(
        `SELECT id FROM inspections
          WHERE vehicle_id = $1 AND inspector_employee_id = $2
            AND status = 'in_progress' AND deleted_at IS NULL`,
        [vehicleId, req.user.id]
      ),
    ]);

    // Odometer: offer the telematics value, but say plainly how old it is.
    // A stale or ignition-off sample is a suggestion to confirm, not a fact.
    let odometer = null;
    if (tel?.last_odometer_km != null) {
      const readAt = tel.last_odometer_at ? new Date(tel.last_odometer_at) : null;
      const ageMs  = readAt ? Date.now() - readAt.getTime() : null;
      const fresh  = ageMs !== null && ageMs <= ODOMETER_FRESH_MS && tel.last_ignition !== 'OFF';
      odometer = {
        suggested_km:    Math.round(Number(tel.last_odometer_km)),
        source:          'telematics',
        reading_at:      tel.last_odometer_at,
        age_minutes:     ageMs === null ? null : Math.round(ageMs / 60000),
        ignition:        tel.last_ignition || null,
        // false → the UI must make the driver confirm before it's accepted
        // as a telematics reading.
        auto_acceptable: fresh,
      };
    }

    let location = null;
    if (tel?.last_location_lat != null && tel?.last_location_lon != null) {
      location = {
        lat: Number(tel.last_location_lat),
        lng: Number(tel.last_location_lon),
        source: 'telematics',
        reading_at: tel.last_location_at,
        // No reverse geocoder is configured on this API, so there is no
        // street address to offer. The client falls back to device GPS or
        // asks the driver to name the place — location_text is a required
        // report field and must not be left to a coordinate pair alone.
        text: null,
      };
    }

    res.json({
      carrier_name: CARRIER_NAME,
      inspector: { employee_id: req.user.id, name: req.user.name },
      vehicle: {
        id: vehicle.id, unit_number: vehicle.unit_number, type: vehicle.type,
        make: vehicle.make, model: vehicle.model, year: vehicle.year,
        plate: vehicle.license_plate, plate_jurisdiction: vehicle.plate_jurisdiction,
        vin: vehicle.vin,
        inspection_required: vehicle.inspection_required,
        registered_gross_weight_kg: vehicle.registered_gross_weight_kg,
      },
      schedule: vehicle.schedule_id ? {
        id: vehicle.schedule_id, name: vehicle.schedule_name,
        reg_reference: vehicle.reg_reference, version: vehicle.schedule_version,
        declaration_text: vehicle.declaration_text,
        source_verified: vehicle.schedule_source_verified,
      } : null,
      odometer,
      previous_odometer_km: prev?.odometer_km ?? null,
      location,
      carried_forward_defects: carried,
      warnings: docWarnings,
      existing_draft_id: existingDraft?.id || null,
      telematics_available: !!tel && !tel.last_fetch_error,
    });
  } catch (e) { next(e); }
});

// ═══════════════════════════════════════════════════════════════════════
// Schedules
// ═══════════════════════════════════════════════════════════════════════

// Items included so the driver's device can cache the whole thing. The
// regulation requires the schedule to be carried in the vehicle, so this has
// to be readable with no signal.
router.get('/fleet/inspection-schedules', requireStaff, async (req, res, next) => {
  try {
    const schedules = await query(
      `SELECT id, name, reg_reference, version, unit_type, declaration_text,
              source_verified, verified_at, active
         FROM inspection_schedules
        WHERE active = TRUE
        ORDER BY unit_type, name, version DESC`
    );
    const items = schedules.length
      ? await query(
          `SELECT id, schedule_id, group_name, item_label, sort_order,
                  minor_defect_text, major_defect_text
             FROM inspection_schedule_items
            WHERE active = TRUE AND schedule_id = ANY($1::int[])
            ORDER BY sort_order, id`,
          [schedules.map((s) => s.id)]
        )
      : [];
    res.json({
      schedules: schedules.map((s) => ({
        ...s,
        items: items.filter((i) => i.schedule_id === s.id),
      })),
    });
  } catch (e) { next(e); }
});

// Marks a schedule's wording as checked against the official MTO source.
// Until this is set the driver UI carries a banner and every report says so.
router.post('/fleet/inspection-schedules/:id/verify', requireAdmin, async (req, res, next) => {
  try {
    const id = intParam(req.params.id);
    if (!id) return badRequest(res, 'Invalid schedule id');
    const row = await queryOne(
      `UPDATE inspection_schedules
          SET source_verified = TRUE, verified_by = $2, verified_at = NOW()
        WHERE id = $1
        RETURNING id, name, version, source_verified, verified_at`,
      [id, req.user.id]
    );
    if (!row) return res.status(404).json({ message: 'Schedule not found' });
    res.json({ ok: true, schedule: row });
  } catch (e) { next(e); }
});

// ═══════════════════════════════════════════════════════════════════════
// Drafts
// ═══════════════════════════════════════════════════════════════════════

// Start a check, or hand back the one already in progress. Idempotent by
// (vehicle, inspector) so a double-tap or a page reload resumes rather than
// creating a second draft.
router.post('/fleet/inspections', requireInspector, async (req, res, next) => {
  const client = await pool.connect();
  try {
    const vehicleId = intParam(req.body?.vehicle_id);
    if (!vehicleId) return badRequest(res, 'vehicle_id is required');

    await client.query('BEGIN');

    const existing = await client.query(
      `SELECT id FROM inspections
        WHERE vehicle_id = $1 AND inspector_employee_id = $2
          AND status = 'in_progress' AND deleted_at IS NULL`,
      [vehicleId, req.user.id]
    );
    if (existing.rows.length) {
      await client.query('COMMIT');
      const row = await loadInspection(existing.rows[0].id);
      return res.json({ inspection: row, defects: await loadDefects(row.id), resumed: true });
    }

    const vres = await client.query(
      `SELECT id, unit_number, license_plate, plate_jurisdiction, inspection_schedule_id
         FROM vehicles WHERE id = $1 AND active = TRUE`,
      [vehicleId]
    );
    const vehicle = vres.rows[0];
    if (!vehicle) { await client.query('ROLLBACK'); return res.status(404).json({ message: 'Vehicle not found' }); }
    if (!vehicle.inspection_schedule_id) {
      await client.query('ROLLBACK');
      return badRequest(res,
        'This unit has no inspection schedule assigned. An admin needs to set one before it can be checked.',
        { code: 'no_schedule' });
    }
    if (!vehicle.license_plate) {
      await client.query('ROLLBACK');
      return badRequest(res,
        'This unit has no plate on file. Plate number is a required field on the report.',
        { code: 'no_plate' });
    }

    // Snapshot the legal identity of the unit and the inspector NOW. If the
    // truck is re-plated tomorrow this report still says what it said today.
    const ins = await client.query(
      `INSERT INTO inspections
         (vehicle_id, schedule_id, carrier_name, plate, plate_jurisdiction,
          inspector_employee_id, inspector_name)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING id`,
      [vehicleId, vehicle.inspection_schedule_id, CARRIER_NAME,
       vehicle.license_plate, vehicle.plate_jurisdiction || 'ON',
       req.user.id, req.user.name || req.user.email]
    );
    const inspectionId = ins.rows[0].id;

    // Carry forward everything still open on this unit. These are pinned:
    // the driver can add a note but cannot unflag them, because only an
    // admin recording a repair closes a defect.
    const carried = await client.query(
      `SELECT d.id, d.severity, d.note, d.schedule_item_id
         FROM inspection_defects d
         JOIN inspections i ON i.id = d.inspection_id
        WHERE i.vehicle_id = $1
          AND i.deleted_at IS NULL
          AND i.completed_at IS NOT NULL
          AND d.resolved_at IS NULL`,
      [vehicleId]
    );
    for (const d of carried.rows) {
      await client.query(
        `INSERT INTO inspection_defects
           (inspection_id, schedule_item_id, severity, note, carried_from_id)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (inspection_id, schedule_item_id) DO NOTHING`,
        [inspectionId, d.schedule_item_id, d.severity, d.note, d.id]
      );
    }

    await client.query('COMMIT');
    const row = await loadInspection(inspectionId);
    res.status(201).json({
      inspection: row,
      defects: await loadDefects(inspectionId),
      resumed: false,
      carried_forward: carried.rows.length,
    });
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    next(e);
  } finally {
    client.release();
  }
});

// Save draft progress. Deliberately a short whitelist: everything a client
// is allowed to influence, and nothing that identifies the report.
router.patch('/fleet/inspections/:id', requireInspector, async (req, res, next) => {
  try {
    const id = intParam(req.params.id);
    if (!id) return badRequest(res, 'Invalid inspection id');
    const draft = await requireOwnDraft(req, res, id);
    if (!draft) return;

    const b = req.body || {};
    const sets = [];
    const vals = [];
    const put = (col, val) => { vals.push(val); sets.push(`${col} = $${vals.length}`); };

    if (b.odometer_km !== undefined) {
      const km = b.odometer_km === null ? null : Number.parseInt(b.odometer_km, 10);
      if (km !== null && (!Number.isInteger(km) || km < 0)) {
        return badRequest(res, 'Odometer must be a whole number of kilometres.');
      }
      put('odometer_km', km);
    }
    if (b.odometer_source !== undefined) {
      if (b.odometer_source !== null && !['telematics', 'manual'].includes(b.odometer_source)) {
        return badRequest(res, 'odometer_source must be telematics or manual');
      }
      put('odometer_source', b.odometer_source);
    }
    if (b.odometer_reading_at !== undefined) put('odometer_reading_at', b.odometer_reading_at);

    if (b.location_lat !== undefined)  put('location_lat', b.location_lat);
    if (b.location_lng !== undefined)  put('location_lng', b.location_lng);
    if (b.location_text !== undefined) put('location_text', b.location_text);
    if (b.location_source !== undefined) {
      if (b.location_source !== null && !['telematics', 'device_gps', 'manual'].includes(b.location_source)) {
        return badRequest(res, 'location_source must be telematics, device_gps or manual');
      }
      put('location_source', b.location_source);
    }

    if (b.driver_employee_id !== undefined) {
      put('driver_employee_id', b.driver_employee_id === null ? null : intParam(b.driver_employee_id));
    }

    if (!sets.length) return badRequest(res, 'Nothing to update');

    vals.push(id);
    await query(`UPDATE inspections SET ${sets.join(', ')} WHERE id = $${vals.length}`, vals);
    res.json({ inspection: await loadInspection(id), defects: await loadDefects(id) });
  } catch (e) { next(e); }
});

// ═══════════════════════════════════════════════════════════════════════
// Defects
// ═══════════════════════════════════════════════════════════════════════

router.post('/fleet/inspections/:id/defects', requireInspector, async (req, res, next) => {
  try {
    const id = intParam(req.params.id);
    if (!id) return badRequest(res, 'Invalid inspection id');
    const draft = await requireOwnDraft(req, res, id);
    if (!draft) return;

    const itemId   = intParam(req.body?.schedule_item_id);
    const severity = req.body?.severity;
    if (!itemId) return badRequest(res, 'schedule_item_id is required');
    if (!['minor', 'major'].includes(severity)) {
      return badRequest(res, 'severity must be minor or major');
    }

    const item = await queryOne(
      `SELECT id, group_name, item_label, major_defect_text
         FROM inspection_schedule_items
        WHERE id = $1 AND schedule_id = $2 AND active = TRUE`,
      [itemId, draft.schedule_id]
    );
    if (!item) return badRequest(res, 'That item is not on this inspection\'s schedule.');

    // An item with no major-defect class in the regulation cannot be flagged
    // major. Letting a driver invent one would put a unit out of service on
    // a basis the schedule doesn't support.
    if (severity === 'major' && !item.major_defect_text) {
      return badRequest(res,
        `"${item.item_label}" has no major defect class on this schedule; it can only be recorded as minor.`,
        { code: 'no_major_class' });
    }

    const row = await queryOne(
      `INSERT INTO inspection_defects (inspection_id, schedule_item_id, severity, note)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (inspection_id, schedule_item_id)
       DO UPDATE SET severity = EXCLUDED.severity,
                     note     = COALESCE(EXCLUDED.note, inspection_defects.note)
       RETURNING id`,
      [id, itemId, severity, req.body?.note || null]
    );
    res.status(201).json({ defect_id: row.id, defects: await loadDefects(id) });
  } catch (e) { next(e); }
});

router.patch('/fleet/inspections/:id/defects/:defectId', requireInspector, async (req, res, next) => {
  try {
    const id = intParam(req.params.id);
    const defectId = intParam(req.params.defectId);
    if (!id || !defectId) return badRequest(res, 'Invalid id');
    const draft = await requireOwnDraft(req, res, id);
    if (!draft) return;

    const existing = await queryOne(
      `SELECT d.id, d.carried_from_id, it.major_defect_text
         FROM inspection_defects d
         JOIN inspection_schedule_items it ON it.id = d.schedule_item_id
        WHERE d.id = $1 AND d.inspection_id = $2`,
      [defectId, id]
    );
    if (!existing) return res.status(404).json({ message: 'Defect not found on this inspection' });

    const b = req.body || {};
    const sets = [];
    const vals = [];
    if (b.severity !== undefined) {
      if (!['minor', 'major'].includes(b.severity)) return badRequest(res, 'severity must be minor or major');
      if (b.severity === 'major' && !existing.major_defect_text) {
        return badRequest(res, 'This item has no major defect class on the schedule.', { code: 'no_major_class' });
      }
      // A carried-forward major defect cannot be downgraded by the driver —
      // that is a repair decision, and repairs are recorded by an admin.
      if (existing.carried_from_id && b.severity === 'minor') {
        return res.status(403).json({
          message: 'A carried-forward defect can only be closed by an admin recording the repair.',
          code: 'carried_forward_locked',
        });
      }
      vals.push(b.severity); sets.push(`severity = $${vals.length}`);
    }
    if (b.note !== undefined) { vals.push(b.note); sets.push(`note = $${vals.length}`); }
    if (!sets.length) return badRequest(res, 'Nothing to update');

    vals.push(defectId);
    await query(`UPDATE inspection_defects SET ${sets.join(', ')} WHERE id = $${vals.length}`, vals);
    res.json({ defects: await loadDefects(id) });
  } catch (e) { next(e); }
});

router.delete('/fleet/inspections/:id/defects/:defectId', requireInspector, async (req, res, next) => {
  try {
    const id = intParam(req.params.id);
    const defectId = intParam(req.params.defectId);
    if (!id || !defectId) return badRequest(res, 'Invalid id');
    const draft = await requireOwnDraft(req, res, id);
    if (!draft) return;

    const existing = await queryOne(
      `SELECT id, carried_from_id FROM inspection_defects
        WHERE id = $1 AND inspection_id = $2`,
      [defectId, id]
    );
    if (!existing) return res.status(404).json({ message: 'Defect not found on this inspection' });
    if (existing.carried_from_id) {
      return res.status(403).json({
        message: 'This defect was carried forward from a previous report and cannot be removed here. An admin closes it by recording the repair.',
        code: 'carried_forward_locked',
      });
    }

    await query(`DELETE FROM inspection_defects WHERE id = $1`, [defectId]);
    res.json({ defects: await loadDefects(id) });
  } catch (e) { next(e); }
});

// Photos go to the same Railway Volume as vehicle documents and stream back
// through an authenticated endpoint — never a public URL. A photo of a
// defect can show a plate, a yard, a customer's site.
router.post('/fleet/inspections/:id/defects/:defectId/photo',
  requireInspector, upload.single('photo'), async (req, res, next) => {
  try {
    const id = intParam(req.params.id);
    const defectId = intParam(req.params.defectId);
    if (!id || !defectId) return badRequest(res, 'Invalid id');
    const draft = await requireOwnDraft(req, res, id);
    if (!draft) return;
    if (!req.file) return badRequest(res, 'No photo uploaded');
    if (!storage.ALLOWED_MIMES.includes(req.file.mimetype)) {
      return badRequest(res, `Unsupported file type ${req.file.mimetype}`);
    }

    const existing = await queryOne(
      `SELECT id, photo_path FROM inspection_defects WHERE id = $1 AND inspection_id = $2`,
      [defectId, id]
    );
    if (!existing) return res.status(404).json({ message: 'Defect not found on this inspection' });

    const saved = await storage.saveDocument({
      vehicleId: draft.vehicle_id,
      docType:   'inspection-defect',
      buffer:    req.file.buffer,
      mime:      req.file.mimetype,
    });

    await query(
      `UPDATE inspection_defects SET photo_path = $2, photo_mime = $3 WHERE id = $1`,
      [defectId, saved.file_path, saved.file_mime]
    );

    // Replacing a photo on a draft: the old file is now unreferenced.
    if (existing.photo_path) {
      storage.deleteDocument(existing.photo_path).catch((err) =>
        console.warn('[inspections] old defect photo cleanup failed:', err.message));
    }

    res.json({ ok: true, defects: await loadDefects(id) });
  } catch (e) { next(e); }
});

router.get('/fleet/inspection-defects/:defectId/photo', requireStaff, async (req, res, next) => {
  try {
    const defectId = intParam(req.params.defectId);
    if (!defectId) return badRequest(res, 'Invalid defect id');
    const row = await queryOne(
      `SELECT photo_path, photo_mime FROM inspection_defects WHERE id = $1`,
      [defectId]
    );
    if (!row?.photo_path) return res.status(404).json({ message: 'No photo on this defect' });
    res.setHeader('Content-Type', row.photo_mime || 'application/octet-stream');
    res.setHeader('Content-Disposition', 'inline');
    const stream = storage.streamDocument(row.photo_path);
    // The file is opened lazily, so a missing file surfaces here rather than
    // above — without this the request hangs until the client times out.
    stream.on('error', (err) => {
      if (!res.headersSent) {
        res.status(err.code === 'ENOENT' ? 404 : 500)
           .json({ message: err.code === 'ENOENT' ? 'Photo file is missing' : 'Could not read photo' });
      } else {
        res.destroy(err);
      }
    });
    stream.pipe(res);
  } catch (e) { next(e); }
});

// ═══════════════════════════════════════════════════════════════════════
// Completion — the point of no return
// ═══════════════════════════════════════════════════════════════════════

router.post('/fleet/inspections/:id/complete', requireInspector, async (req, res, next) => {
  const client = await pool.connect();
  let completed = null;
  try {
    const id = intParam(req.params.id);
    if (!id) return badRequest(res, 'Invalid inspection id');
    const draft = await requireOwnDraft(req, res, id);
    if (!draft) return;

    const b = req.body || {};

    // ── The declaration is the signature. It has to be explicit. ──
    if (b.declaration_accepted !== true) {
      return badRequest(res, 'The declaration must be accepted to complete the report.', {
        code: 'declaration_required',
      });
    }
    // Snapshot the wording from the SCHEDULE, never from the request body.
    // A client that could choose the declaration text could sign a driver's
    // name to a statement they never saw.
    const schedule = await queryOne(
      `SELECT declaration_text, name, reg_reference, source_verified
         FROM inspection_schedules WHERE id = $1`,
      [draft.schedule_id]
    );
    if (!schedule?.declaration_text) {
      return res.status(409).json({
        message: 'This schedule has no declaration wording configured. An admin must set it before reports can be signed.',
        code: 'no_declaration',
      });
    }

    // ── Defects, and the explicit "none found" the regulation requires ──
    const defects = await loadDefects(id);
    const hasMajor = defects.some((d) => d.severity === 'major');
    if (defects.length === 0 && b.no_defects !== true) {
      return badRequest(res,
        'The report must either list defects or state explicitly that none were found.',
        { code: 'no_defects_statement_required' });
    }
    if (defects.length > 0 && b.no_defects === true) {
      return badRequest(res, 'Defects are recorded on this report, so it cannot state that none were found.');
    }

    // ── Odometer ──
    const km = b.odometer_km !== undefined
      ? Number.parseInt(b.odometer_km, 10)
      : draft.odometer_km;
    if (!Number.isInteger(km) || km < 0) {
      return badRequest(res, 'An odometer reading is required on the report.', { code: 'odometer_required' });
    }
    const odoSource = b.odometer_source || draft.odometer_source || 'manual';
    if (!['telematics', 'manual'].includes(odoSource)) {
      return badRequest(res, 'odometer_source must be telematics or manual');
    }

    const warnings = await documentWarnings(draft.vehicle_id);

    // A reading below the last signed report is rejected, not silently
    // taken. It is almost always a typo; when it genuinely isn't (cluster
    // replaced, digit rolled), the driver acknowledges it and the
    // acknowledgement goes on the record.
    const prev = await previousOdometer(draft.vehicle_id, id);
    if (prev && km < prev.odometer_km) {
      if (b.odometer_regression_ack !== true) {
        return res.status(409).json({
          message: `Odometer ${km} km is lower than the last report's ${prev.odometer_km} km. Check the reading.`,
          code: 'odometer_regression',
          previous_odometer_km: prev.odometer_km,
          previous_completed_at: prev.completed_at,
        });
      }
      warnings.push({
        type: 'odometer_regression', severity: 'medium',
        previous_odometer_km: prev.odometer_km, recorded_odometer_km: km,
        message: `Reading is ${prev.odometer_km - km} km below the previous report; acknowledged by the inspector.`,
      });
    }

    // ── Location ──
    const locationText = b.location_text ?? draft.location_text;
    if (!locationText || !String(locationText).trim()) {
      return badRequest(res, 'The location of the inspection is a required field.', {
        code: 'location_required',
      });
    }
    const locSource = b.location_source || draft.location_source || 'manual';
    if (!['telematics', 'device_gps', 'manual'].includes(locSource)) {
      return badRequest(res, 'location_source must be telematics, device_gps or manual');
    }

    // ── Driver signature, where the driver didn't do the inspection ──
    const driverEmployeeId = b.driver_employee_id !== undefined
      ? (b.driver_employee_id === null ? null : intParam(b.driver_employee_id))
      : draft.driver_employee_id;
    let driverSigName = null;
    let driverSigAt   = null;
    if (driverEmployeeId && driverEmployeeId !== draft.inspector_employee_id) {
      driverSigName = (b.driver_signature_name || '').trim();
      if (!driverSigName) {
        return badRequest(res,
          'The driver did not perform this inspection, so the driver must sign the report.',
          { code: 'driver_signature_required' });
      }
      driverSigAt = new Date();
    }

    // ── Out of service ──
    // Major on THIS report, or any major still open on the unit from an
    // earlier one. A unit does not come back into service because someone
    // ran a fresh check on it; it comes back when the repair is recorded.
    const openMajor = await queryOne(
      `SELECT COUNT(*)::int AS n
         FROM inspection_defects d
         JOIN inspections i ON i.id = d.inspection_id
        WHERE i.vehicle_id = $1 AND i.deleted_at IS NULL
          AND i.completed_at IS NOT NULL
          AND d.severity = 'major' AND d.resolved_at IS NULL`,
      [draft.vehicle_id]
    );
    const status = (hasMajor || (openMajor?.n || 0) > 0) ? 'out_of_service' : 'complete';

    if (!schedule.source_verified) {
      warnings.push({
        type: 'schedule_unverified', severity: 'high',
        message: 'Signed against schedule wording that has not yet been verified against the official MTO source.',
      });
    }

    await client.query('BEGIN');
    // completed_at is set by the server, from the server clock. It is the
    // timestamp on a legal record; a client cannot choose it.
    const upd = await client.query(
      `UPDATE inspections
          SET odometer_km             = $2,
              odometer_source         = $3,
              odometer_reading_at     = $4,
              location_lat            = $5,
              location_lng            = $6,
              location_text           = $7,
              location_source         = $8,
              driver_employee_id      = $9,
              driver_signature_name   = $10,
              driver_signature_at     = $11,
              no_defects              = $12,
              declaration_text        = $13,
              declaration_accepted_at = NOW(),
              warnings                = $14::jsonb,
              status                  = $15,
              completed_at            = NOW(),
              submitted_at            = NOW()
        WHERE id = $1 AND completed_at IS NULL
        RETURNING id`,
      [
        id, km, odoSource,
        b.odometer_reading_at ?? draft.odometer_reading_at,
        b.location_lat ?? draft.location_lat,
        b.location_lng ?? draft.location_lng,
        String(locationText).trim(), locSource,
        driverEmployeeId, driverSigName, driverSigAt,
        defects.length === 0,
        schedule.declaration_text,
        JSON.stringify(warnings),
        status,
      ]
    );
    if (!upd.rows.length) {
      await client.query('ROLLBACK');
      return res.status(409).json({
        message: 'This inspection was already completed.',
        code: 'already_complete',
      });
    }
    await client.query('COMMIT');

    completed = await loadInspection(id);
    const finalDefects = await loadDefects(id);

    res.json({
      inspection: completed,
      defects: finalDefects,
      out_of_service: status === 'out_of_service',
    });

    // ── Notify, after the response. A mail failure must never make a
    //    driver think their completed check didn't save. ──
    if (status === 'out_of_service') {
      const majors = finalDefects.filter((d) => d.severity === 'major');
      mailer.sendInspectionOutOfServiceAlert({ inspection: completed, defects: majors })
        .catch((err) => console.error('[inspections] out-of-service alert failed:', err.message));
    }
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    if (!res.headersSent) return next(e);
    console.error('[inspections] post-response error:', e.message);
  } finally {
    client.release();
  }
});

// ═══════════════════════════════════════════════════════════════════════
// Reading reports
// ═══════════════════════════════════════════════════════════════════════

router.get('/fleet/inspections', requireStaff, async (req, res, next) => {
  try {
    const where = ['i.deleted_at IS NULL'];
    const vals  = [];
    const vehicleId = intParam(req.query.vehicle_id);
    if (vehicleId) { vals.push(vehicleId); where.push(`i.vehicle_id = $${vals.length}`); }
    if (req.query.status) { vals.push(req.query.status); where.push(`i.status = $${vals.length}`); }
    if (req.query.mine === '1') { vals.push(req.user.id); where.push(`i.inspector_employee_id = $${vals.length}`); }

    const limit = Math.min(Number.parseInt(req.query.limit, 10) || 50, 200);
    vals.push(limit);

    const rows = await query(
      `SELECT i.id, i.vehicle_id, i.plate, i.plate_jurisdiction, i.inspector_name,
              i.started_at, i.completed_at, i.valid_until, i.status,
              i.odometer_km, i.odometer_source, i.location_text, i.no_defects,
              v.unit_number,
              COALESCE(dc.n, 0)     AS defect_count,
              COALESCE(dc.majors, 0) AS major_count
         FROM inspections i
         JOIN vehicles v ON v.id = i.vehicle_id
         LEFT JOIN LATERAL (
           SELECT COUNT(*)::int AS n,
                  COUNT(*) FILTER (WHERE severity = 'major')::int AS majors
             FROM inspection_defects WHERE inspection_id = i.id
         ) dc ON TRUE
        WHERE ${where.join(' AND ')}
        ORDER BY COALESCE(i.completed_at, i.started_at) DESC
        LIMIT $${vals.length}`,
      vals
    );
    res.json({ inspections: rows });
  } catch (e) { next(e); }
});

// Open defect queue for /fleet-admin/inspections/defects.
router.get('/fleet/inspection-defects/open', requireStaff, async (req, res, next) => {
  try {
    const rows = await query(
      `SELECT d.id, d.severity, d.note, d.photo_path IS NOT NULL AS has_photo,
              d.created_at, d.carried_from_id,
              i.id AS inspection_id, i.completed_at, i.inspector_name,
              i.vehicle_id, v.unit_number, i.plate,
              it.group_name, it.item_label, it.minor_defect_text, it.major_defect_text
         FROM inspection_defects d
         JOIN inspections i                ON i.id  = d.inspection_id
         JOIN vehicles v                   ON v.id  = i.vehicle_id
         JOIN inspection_schedule_items it ON it.id = d.schedule_item_id
        WHERE d.resolved_at IS NULL
          AND i.deleted_at IS NULL
          AND i.completed_at IS NOT NULL
        ORDER BY (d.severity = 'major') DESC, i.completed_at DESC`
    );
    res.json({ defects: rows });
  } catch (e) { next(e); }
});

// Recording the repair is what brings a unit back into service, so it is
// admin-only and a repair note is mandatory.
router.post('/fleet/inspection-defects/:defectId/resolve', requireAdmin, async (req, res, next) => {
  try {
    const defectId = intParam(req.params.defectId);
    if (!defectId) return badRequest(res, 'Invalid defect id');
    const note = (req.body?.repair_note || '').trim();
    if (!note) {
      return badRequest(res, 'A repair note is required to close a defect.', { code: 'repair_note_required' });
    }

    const row = await queryOne(
      `UPDATE inspection_defects
          SET resolved_at = NOW(), resolved_by = $2, repair_note = $3
        WHERE id = $1 AND resolved_at IS NULL
        RETURNING id, inspection_id, severity`,
      [defectId, req.user.id, note]
    );
    if (!row) return res.status(404).json({ message: 'Defect not found, or already resolved' });

    // The unit returns to service only once nothing major is open on it.
    // Reports keep their own out_of_service status forever — that is what
    // the report said when it was signed — so the live answer is computed
    // from open defects, not read off the last report.
    const insp = await queryOne(`SELECT vehicle_id FROM inspections WHERE id = $1`, [row.inspection_id]);
    const still = await queryOne(
      `SELECT COUNT(*)::int AS n
         FROM inspection_defects d
         JOIN inspections i ON i.id = d.inspection_id
        WHERE i.vehicle_id = $1 AND i.deleted_at IS NULL
          AND d.severity = 'major' AND d.resolved_at IS NULL`,
      [insp.vehicle_id]
    );
    res.json({ ok: true, defect_id: row.id, vehicle_back_in_service: (still?.n || 0) === 0 });
  } catch (e) { next(e); }
});

// ═══════════════════════════════════════════════════════════════════════
// Offline sync
// ═══════════════════════════════════════════════════════════════════════

// A check performed with no signal arrives here as one complete document
// rather than the create → patch → flag → complete sequence the online path
// uses. It is written and frozen in a single transaction, because a
// half-synced inspection is not a lesser record — it is a draft nobody is
// going to come back and finish.
//
// Three things make this safe to retry, which matters because a phone in a
// yard WILL retry:
//   * client_uuid is unique, so the second POST returns the first result
//   * the whole write is one transaction, so there is no partial state
//   * the driver's clock is bounds-checked, not trusted
router.post('/fleet/inspections/sync', requireInspector, async (req, res, next) => {
  const client = await pool.connect();
  let completed = null;
  try {
    const b = req.body || {};
    const clientUuid = typeof b.client_uuid === 'string' ? b.client_uuid.trim() : '';
    if (!/^[0-9a-fA-F-]{16,64}$/.test(clientUuid)) {
      return badRequest(res, 'client_uuid is required and must be a UUID.');
    }

    // Idempotency first: a retry must never reach the write path.
    const existing = await queryOne(
      `SELECT id FROM inspections WHERE client_uuid = $1`, [clientUuid]
    );
    if (existing) {
      return res.json({
        inspection: await loadInspection(existing.id),
        defects: await loadDefects(existing.id),
        duplicate: true,
      });
    }

    const vehicleId = intParam(b.vehicle_id);
    if (!vehicleId) return badRequest(res, 'vehicle_id is required');
    if (b.declaration_accepted !== true) {
      return badRequest(res, 'The declaration must be accepted.', { code: 'declaration_required' });
    }

    // ── Bounds-check the device clock ──
    // Generous backwards (a Friday-evening check synced Monday morning is
    // ~60 h old and perfectly legitimate), tight forwards, because a clock
    // ahead of the server is a broken clock and a report dated in the future
    // is indefensible.
    const clientAt = new Date(b.client_completed_at);
    if (Number.isNaN(clientAt.getTime())) {
      return badRequest(res, 'client_completed_at is required and must be a timestamp.');
    }
    const now = Date.now();
    const skewMs = now - clientAt.getTime();
    if (skewMs < -MAX_CLOCK_AHEAD_MS) {
      return badRequest(res,
        'This check is dated in the future. Correct the device clock and record the check again.',
        { code: 'client_clock_ahead' });
    }
    if (skewMs > MAX_OFFLINE_AGE_MS) {
      return badRequest(res,
        'This check is older than the sync window and cannot be accepted as a current report. Perform a new check.',
        { code: 'client_clock_stale', age_hours: Math.round(skewMs / 3600000) });
    }

    const vehicle = await queryOne(
      `SELECT id, unit_number, license_plate, plate_jurisdiction, inspection_schedule_id
         FROM vehicles WHERE id = $1 AND active = TRUE`,
      [vehicleId]
    );
    if (!vehicle) return res.status(404).json({ message: 'Vehicle not found' });
    if (!vehicle.inspection_schedule_id) {
      return badRequest(res, 'This unit has no inspection schedule assigned.', { code: 'no_schedule' });
    }
    if (!vehicle.license_plate) {
      return badRequest(res, 'This unit has no plate on file.', { code: 'no_plate' });
    }

    const schedule = await queryOne(
      `SELECT declaration_text, source_verified FROM inspection_schedules WHERE id = $1`,
      [vehicle.inspection_schedule_id]
    );
    if (!schedule?.declaration_text) {
      return res.status(409).json({ message: 'This schedule has no declaration wording configured.', code: 'no_declaration' });
    }

    // ── Validate the defect list against the schedule ──
    const rawDefects = Array.isArray(b.defects) ? b.defects : [];
    const items = await query(
      `SELECT id, item_label, major_defect_text FROM inspection_schedule_items
        WHERE schedule_id = $1 AND active = TRUE`,
      [vehicle.inspection_schedule_id]
    );
    const itemById = new Map(items.map((i) => [i.id, i]));
    const seenItems = new Set();
    for (const d of rawDefects) {
      const item = itemById.get(intParam(d.schedule_item_id));
      if (!item) return badRequest(res, 'A recorded defect is not on this unit\'s schedule.');
      if (!['minor', 'major'].includes(d.severity)) {
        return badRequest(res, 'severity must be minor or major');
      }
      if (d.severity === 'major' && !item.major_defect_text) {
        return badRequest(res, `"${item.item_label}" has no major defect class on this schedule.`,
          { code: 'no_major_class' });
      }
      if (seenItems.has(item.id)) {
        return badRequest(res, `"${item.item_label}" is recorded twice on this report.`);
      }
      seenItems.add(item.id);
    }

    if (rawDefects.length === 0 && b.no_defects !== true) {
      return badRequest(res,
        'The report must either list defects or state explicitly that none were found.',
        { code: 'no_defects_statement_required' });
    }

    const km = Number.parseInt(b.odometer_km, 10);
    if (!Number.isInteger(km) || km < 0) {
      return badRequest(res, 'An odometer reading is required.', { code: 'odometer_required' });
    }
    const odoSource = ['telematics', 'manual'].includes(b.odometer_source) ? b.odometer_source : 'manual';

    const locationText = (b.location_text || '').trim();
    if (!locationText) {
      return badRequest(res, 'The location of the inspection is a required field.', { code: 'location_required' });
    }
    const locSource = ['telematics', 'device_gps', 'manual'].includes(b.location_source)
      ? b.location_source : 'manual';

    // ── Warnings: recomputed here, plus what only sync can know ──
    const warnings = await documentWarnings(vehicleId);
    if (!schedule.source_verified) {
      warnings.push({
        type: 'schedule_unverified', severity: 'high',
        message: 'Signed against schedule wording that has not yet been verified against the official MTO source.',
      });
    }
    warnings.push({
      type: 'captured_offline', severity: 'low',
      client_completed_at: clientAt.toISOString(),
      delay_minutes: Math.round(skewMs / 60000),
      message: `Recorded offline and synced ${Math.round(skewMs / 60000)} minutes later.`,
    });

    const prev = await previousOdometer(vehicleId);
    if (prev && km < prev.odometer_km) {
      // There is nobody to ask now — the driver has moved on. Record it and
      // surface it, rather than dropping a completed inspection on the floor.
      warnings.push({
        type: 'odometer_regression', severity: 'medium',
        previous_odometer_km: prev.odometer_km, recorded_odometer_km: km,
        message: `Reading is ${prev.odometer_km - km} km below the previous report. Recorded offline, so it could not be confirmed at the time.`,
      });
    }

    const hasMajor = rawDefects.some((d) => d.severity === 'major');
    const openMajor = await queryOne(
      `SELECT COUNT(*)::int AS n
         FROM inspection_defects d
         JOIN inspections i ON i.id = d.inspection_id
        WHERE i.vehicle_id = $1 AND i.deleted_at IS NULL
          AND i.completed_at IS NOT NULL
          AND d.severity = 'major' AND d.resolved_at IS NULL`,
      [vehicleId]
    );
    const status = (hasMajor || (openMajor?.n || 0) > 0) ? 'out_of_service' : 'complete';

    // ── One transaction: draft, defects, freeze ──
    // Deliberately the same three steps the online path takes, rather than a
    // single pre-completed INSERT. Migration 060 refuses defect writes
    // against a completed inspection, and that guard is worth more than the
    // round trip it costs here — a synced report goes through exactly the
    // same freeze as one signed at the counter.
    await client.query('BEGIN');
    const ins = await client.query(
      `INSERT INTO inspections
         (vehicle_id, schedule_id, carrier_name, plate, plate_jurisdiction,
          inspector_employee_id, inspector_name, client_uuid, started_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8, COALESCE($9::timestamptz, $10::timestamptz))
       RETURNING id`,
      [
        vehicleId, vehicle.inspection_schedule_id, CARRIER_NAME,
        vehicle.license_plate, vehicle.plate_jurisdiction || 'ON',
        req.user.id, req.user.name || req.user.email,
        clientUuid,
        b.client_started_at || null,
        clientAt.toISOString(),
      ]
    );
    const inspectionId = ins.rows[0].id;

    for (const d of rawDefects) {
      // carried_from_id is honoured only if it really is an open defect on
      // THIS unit. A client-supplied id is otherwise just an assertion, and
      // the carry-forward chain is what stops a defect being walked away
      // from between reports.
      const carriedFrom = intParam(d.carried_from_id);
      const carryOk = carriedFrom ? await queryOne(
        `SELECT d.id FROM inspection_defects d
           JOIN inspections i ON i.id = d.inspection_id
          WHERE d.id = $1 AND i.vehicle_id = $2 AND d.resolved_at IS NULL`,
        [carriedFrom, vehicleId]
      ) : null;

      await client.query(
        `INSERT INTO inspection_defects (inspection_id, schedule_item_id, severity, note, carried_from_id)
         VALUES ($1, $2, $3, $4, $5)`,
        [inspectionId, intParam(d.schedule_item_id), d.severity, d.note || null, carryOk ? carriedFrom : null]
      );
    }

    await client.query(
      `UPDATE inspections
          SET completed_at            = $2::timestamptz,
              client_completed_at     = $2::timestamptz,
              server_received_at      = NOW(),
              completed_offline       = TRUE,
              odometer_km             = $3,
              odometer_source         = $4,
              odometer_reading_at     = $5,
              location_lat            = $6,
              location_lng            = $7,
              location_text           = $8,
              location_source         = $9,
              no_defects              = $10,
              declaration_text        = $11,
              declaration_accepted_at = $2::timestamptz,
              warnings                = $12::jsonb,
              status                  = $13,
              submitted_at            = NOW()
        WHERE id = $1`,
      [
        inspectionId, clientAt.toISOString(),
        km, odoSource, b.odometer_reading_at || null,
        b.location_lat ?? null, b.location_lng ?? null, locationText, locSource,
        rawDefects.length === 0,
        schedule.declaration_text,
        JSON.stringify(warnings),
        status,
      ]
    );
    await client.query('COMMIT');

    completed = await loadInspection(inspectionId);
    const finalDefects = await loadDefects(inspectionId);
    res.status(201).json({
      inspection: completed,
      defects: finalDefects,
      out_of_service: status === 'out_of_service',
      duplicate: false,
    });

    if (status === 'out_of_service') {
      mailer.sendInspectionOutOfServiceAlert({
        inspection: completed,
        defects: finalDefects.filter((d) => d.severity === 'major'),
      }).catch((err) => console.error('[inspections] out-of-service alert failed:', err.message));
    }
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    // A racing retry can lose the unique-index race rather than the SELECT
    // above; treat that as the duplicate it is.
    if (e.code === '23505' && !res.headersSent) {
      const dup = await queryOne(
        `SELECT id FROM inspections WHERE client_uuid = $1`, [req.body?.client_uuid]
      ).catch(() => null);
      if (dup) {
        return res.json({
          inspection: await loadInspection(dup.id),
          defects: await loadDefects(dup.id),
          duplicate: true,
        });
      }
    }
    if (!res.headersSent) return next(e);
    console.error('[inspections] post-response sync error:', e.message);
  } finally {
    client.release();
  }
});

// The last signed report per unit, for the driver's device to cache. This is
// the document the regulation requires them to be carrying, so it has to be
// readable with no signal — which means it has to be fetchable in one call
// while they still have signal.
router.get('/fleet/inspections/offline-bundle', requireInspector, async (req, res, next) => {
  try {
    const [units, schedules, latest] = await Promise.all([
      query(
        `SELECT v.id, v.unit_number, v.type, v.make, v.model, v.year,
                v.license_plate, v.plate_jurisdiction, v.inspection_required,
                v.inspection_schedule_id
           FROM vehicles v
          WHERE v.active = TRUE AND v.inspection_schedule_id IS NOT NULL
          ORDER BY v.inspection_required DESC, v.unit_number`
      ),
      query(
        `SELECT s.id, s.name, s.reg_reference, s.version, s.unit_type,
                s.declaration_text, s.source_verified
           FROM inspection_schedules s
          WHERE s.active = TRUE`
      ),
      query(
        `SELECT DISTINCT ON (i.vehicle_id)
                i.id, i.vehicle_id, i.plate, i.plate_jurisdiction, i.carrier_name,
                i.inspector_name, i.completed_at, i.valid_until, i.status,
                i.odometer_km, i.odometer_source, i.location_text,
                i.no_defects, i.declaration_text, i.declaration_accepted_at,
                v.unit_number
           FROM inspections i
           JOIN vehicles v ON v.id = i.vehicle_id
          WHERE i.completed_at IS NOT NULL AND i.deleted_at IS NULL
            AND i.status <> 'superseded'
          ORDER BY i.vehicle_id, i.completed_at DESC`
      ),
    ]);

    const items = schedules.length
      ? await query(
          `SELECT id, schedule_id, group_name, item_label, sort_order,
                  minor_defect_text, major_defect_text
             FROM inspection_schedule_items
            WHERE active = TRUE AND schedule_id = ANY($1::int[])
            ORDER BY sort_order, id`,
          [schedules.map((s) => s.id)]
        )
      : [];

    // Open defects travel in the bundle too. Without them an offline check
    // would silently drop the carried-forward items — which are exactly the
    // ones that must not be droppable, since only an admin can close them.
    const openDefects = await query(
      `SELECT d.id, d.severity, d.note, d.schedule_item_id, i.vehicle_id,
              i.completed_at AS reported_at, i.inspector_name AS reported_by,
              it.group_name, it.item_label, it.minor_defect_text, it.major_defect_text
         FROM inspection_defects d
         JOIN inspections i                ON i.id  = d.inspection_id
         JOIN inspection_schedule_items it ON it.id = d.schedule_item_id
        WHERE d.resolved_at IS NULL
          AND i.deleted_at IS NULL
          AND i.completed_at IS NOT NULL
        ORDER BY i.vehicle_id, d.severity DESC, d.created_at`
    );

    res.json({
      carrier_name: CARRIER_NAME,
      inspector: { employee_id: req.user.id, name: req.user.name },
      units,
      schedules: schedules.map((s) => ({ ...s, items: items.filter((i) => i.schedule_id === s.id) })),
      last_reports: latest,
      open_defects: openDefects,
      fetched_at: new Date().toISOString(),
    });
  } catch (e) { next(e); }
});

// ═══════════════════════════════════════════════════════════════════════
// Scheduled jobs — status and manual run
// ═══════════════════════════════════════════════════════════════════════

router.get('/fleet/inspection-jobs', requireStaff, async (req, res, next) => {
  try {
    const runs = await query(
      `SELECT DISTINCT ON (job_name)
              job_name, run_key, started_at, finished_at, ok, detail
         FROM scheduled_job_runs
        WHERE job_name IN ('inspection-daily-digest','fleet-expiry-digest','inspection-retention')
        ORDER BY job_name, started_at DESC`
    );
    res.json({ runs, shop_time: jobs._internals.shopNow() });
  } catch (e) { next(e); }
});

// Runs a job right now, bypassing the once-per-period claim. This exists
// because otherwise the only way to find out whether the 07:00 digest works
// is to wait until 07:00 and see. A forced run does NOT write a claim row,
// so it cannot suppress the real scheduled run later the same day.
const JOB_RUNNERS = {
  'inspection-daily-digest': jobs.runDailyDigest,
  'fleet-expiry-digest':     jobs.runExpiryDigest,
  'inspection-retention':    jobs.runRetentionArchive,
};

router.post('/fleet/inspection-jobs/:name/run', requireAdmin, async (req, res, next) => {
  try {
    const runner = JOB_RUNNERS[req.params.name];
    if (!runner) {
      return badRequest(res, `Unknown job. Known jobs: ${Object.keys(JOB_RUNNERS).join(', ')}`);
    }
    const result = await runner({ force: true });
    res.json({ ok: true, job: req.params.name, forced: true, result });
  } catch (e) { next(e); }
});

// Prompt shown when a driver clocks in: does the unit they most recently
// worked with still need a check today? Returns null rather than an error
// when there is nothing to prompt, so the Time Clock UI can call it
// unconditionally and ignore a null.
router.get('/fleet/inspections/prompt', requireInspector, async (req, res, next) => {
  try {
    const last = await queryOne(
      `SELECT i.vehicle_id, v.unit_number
         FROM inspections i
         JOIN vehicles v ON v.id = i.vehicle_id
        WHERE i.inspector_employee_id = $1
          AND i.deleted_at IS NULL
          AND v.active = TRUE
          AND v.inspection_required = TRUE
        ORDER BY COALESCE(i.completed_at, i.started_at) DESC
        LIMIT 1`,
      [req.user.id]
    );
    if (!last) return res.json({ prompt: null });

    const valid = await queryOne(
      `SELECT id, valid_until FROM inspections
        WHERE vehicle_id = $1 AND status = 'complete'
          AND deleted_at IS NULL AND valid_until > NOW()
        ORDER BY completed_at DESC LIMIT 1`,
      [last.vehicle_id]
    );
    if (valid) return res.json({ prompt: null, valid_until: valid.valid_until });

    res.json({
      prompt: {
        vehicle_id: last.vehicle_id,
        unit_number: last.unit_number,
        message: `${last.unit_number} has no valid circle check today.`,
        href: '/fleet/check',
      },
    });
  } catch (e) { next(e); }
});

// Kept last: /:id would otherwise swallow /scope, /prefill and the rest.
router.get('/fleet/inspections/:id', requireStaff, async (req, res, next) => {
  try {
    const id = intParam(req.params.id);
    if (!id) return badRequest(res, 'Invalid inspection id');
    const inspection = await loadInspection(id);
    if (!inspection) return res.status(404).json({ message: 'Inspection not found' });
    const [defects, items] = await Promise.all([
      loadDefects(id),
      query(
        `SELECT id, group_name, item_label, sort_order, minor_defect_text, major_defect_text
           FROM inspection_schedule_items
          WHERE schedule_id = $1 AND active = TRUE
          ORDER BY sort_order, id`,
        [inspection.schedule_id]
      ),
    ]);
    res.json({ inspection, defects, schedule_items: items, carrier_name: inspection.carrier_name });
  } catch (e) { next(e); }
});

module.exports = router;
