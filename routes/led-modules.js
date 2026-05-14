// routes/led-modules.js
// Spec catalog of LED display module types, used by the LED Sign Quoting
// tool on the frontend (/admin/led-quote). Mounted at /api/led-modules.
// Schema in db/migrations/019_led_modules.sql.
//
// NOT the same thing as /api/clients/modules — that endpoint manages
// per-client inventory rows (module_id_no, on_hand). This one is a
// shared catalog of module dimensions / pitch / power for quoting.
//
// Endpoints:
//   GET    /                List active modules (or all with ?include_inactive=1)
//   GET    /:id             Single module
//   POST   /                Create
//   PUT    /:id             Partial update
//   DELETE /:id             Soft delete (sets is_active=false). Old quotes
//                           that reference the row by id still resolve.
//
// All endpoints require staff (or admin). Quoting is a staff workflow;
// non-staff clients should never hit these.

'use strict';

const express = require('express');
const { query, queryOne } = require('../db/connection');
const { requireStaff } = require('../middleware/auth');
const router = express.Router();

// Whitelisted writable columns. Keeps PUT honest — extra body keys are
// ignored silently rather than blowing up the query builder.
const WRITABLE = ['name', 'width_mm', 'height_mm', 'pitch_mm', 'max_watts', 'control_system'];

// Postgres NUMERIC comes back as a string (so JS doesn't lose precision on
// huge values). For the quoting math the frontend wants numbers, and these
// are all bounded small values — coerce here.
function formatModule(row) {
  if (!row) return null;
  return {
    id:             row.id,
    name:           row.name,
    width_mm:       row.width_mm  == null ? null : Number(row.width_mm),
    height_mm:      row.height_mm == null ? null : Number(row.height_mm),
    pitch_mm:       row.pitch_mm  == null ? null : Number(row.pitch_mm),
    max_watts:      row.max_watts == null ? null : Number(row.max_watts),
    control_system: row.control_system,
    is_active:      row.is_active,
    created_at:     row.created_at,
    updated_at:     row.updated_at,
  };
}

// Pulls (name, width_mm, height_mm, pitch_mm, max_watts, control_system?)
// out of req.body, validates required + positive-numeric, and returns
// either { ok: true, values } or { ok: false, message }.
// Pass partial=true to skip the "must include all required fields" check
// (used by PUT, where any subset is fine).
function pickAndValidate(body, { partial = false } = {}) {
  const values = {};
  const errors = [];

  if (body.name !== undefined) {
    const name = String(body.name).trim();
    if (!name) errors.push('name cannot be empty');
    else values.name = name;
  } else if (!partial) {
    errors.push('name is required');
  }

  for (const col of ['width_mm', 'height_mm', 'pitch_mm', 'max_watts']) {
    if (body[col] !== undefined) {
      const n = Number(body[col]);
      if (!Number.isFinite(n) || n <= 0) errors.push(`${col} must be a positive number`);
      else values[col] = n;
    } else if (!partial) {
      errors.push(`${col} is required`);
    }
  }

  if (body.control_system !== undefined) {
    // Empty string is legitimate — means "no control system specified" and
    // gets stored as NULL.
    const cs = String(body.control_system).trim();
    values.control_system = cs || null;
  }

  if (errors.length) return { ok: false, message: errors.join('; ') };
  return { ok: true, values };
}

// ─── GET /api/led-modules ─────────────────────────────────────────────
// By default returns only active modules — the dropdown on /admin/led-quote
// wants the live catalog, not retired entries. Pass ?include_inactive=1
// to see everything (admin maintenance view).
router.get('/', requireStaff, async (req, res) => {
  const includeInactive = req.query.include_inactive === '1' || req.query.include_inactive === 'true';
  const where = includeInactive ? '' : 'WHERE is_active = TRUE';
  try {
    const rows = await query(
      `SELECT * FROM led_modules ${where} ORDER BY name ASC`
    );
    res.json({ count: rows.length, modules: rows.map(formatModule) });
  } catch (e) {
    console.error('GET /api/led-modules failed:', e);
    res.status(500).json({ message: 'Lookup failed', detail: e.message });
  }
});

// ─── GET /api/led-modules/:id ────────────────────────────────────────
router.get('/:id', requireStaff, async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!Number.isInteger(id)) return res.status(400).json({ message: 'invalid id' });
  try {
    const row = await queryOne(`SELECT * FROM led_modules WHERE id = $1`, [id]);
    if (!row) return res.status(404).json({ message: 'not found' });
    res.json(formatModule(row));
  } catch (e) {
    console.error('GET /api/led-modules/:id failed:', e);
    res.status(500).json({ message: 'Lookup failed', detail: e.message });
  }
});

// ─── POST /api/led-modules ───────────────────────────────────────────
// Body: { name, width_mm, height_mm, pitch_mm, max_watts, control_system? }
router.post('/', requireStaff, async (req, res) => {
  const { ok, values, message } = pickAndValidate(req.body || {});
  if (!ok) return res.status(400).json({ message });
  try {
    const row = await queryOne(
      `INSERT INTO led_modules (name, width_mm, height_mm, pitch_mm, max_watts, control_system)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING *`,
      [values.name, values.width_mm, values.height_mm, values.pitch_mm, values.max_watts,
       values.control_system ?? null]
    );
    res.status(201).json(formatModule(row));
  } catch (e) {
    console.error('POST /api/led-modules failed:', e);
    res.status(500).json({ message: 'Create failed', detail: e.message });
  }
});

// ─── PUT /api/led-modules/:id ────────────────────────────────────────
// Partial update — only the fields present in the body are changed.
// Sending { is_active: true } here is intentionally NOT supported; use
// the unsupported-but-easy path of issuing UPDATE through the DB if you
// need to un-retire a module. The dropdown filter is "active only" anyway.
router.put('/:id', requireStaff, async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!Number.isInteger(id)) return res.status(400).json({ message: 'invalid id' });

  const { ok, values, message } = pickAndValidate(req.body || {}, { partial: true });
  if (!ok) return res.status(400).json({ message });

  const cols = WRITABLE.filter(c => Object.prototype.hasOwnProperty.call(values, c));
  if (cols.length === 0) return res.status(400).json({ message: 'no updatable fields supplied' });

  const setClauses = cols.map((c, i) => `${c} = $${i + 1}`).join(', ');
  const params = cols.map(c => values[c]);
  params.push(id);

  try {
    const row = await queryOne(
      `UPDATE led_modules SET ${setClauses}
        WHERE id = $${params.length}
        RETURNING *`,
      params
    );
    if (!row) return res.status(404).json({ message: 'not found' });
    res.json(formatModule(row));
  } catch (e) {
    console.error('PUT /api/led-modules/:id failed:', e);
    res.status(500).json({ message: 'Update failed', detail: e.message });
  }
});

// ─── DELETE /api/led-modules/:id ─────────────────────────────────────
// Soft delete: flips is_active=false so existing quote descriptions that
// resolve the module by id still work, but the row drops out of the
// /admin/led-quote dropdown.
router.delete('/:id', requireStaff, async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!Number.isInteger(id)) return res.status(400).json({ message: 'invalid id' });
  try {
    const row = await queryOne(
      `UPDATE led_modules SET is_active = FALSE WHERE id = $1 RETURNING *`,
      [id]
    );
    if (!row) return res.status(404).json({ message: 'not found' });
    res.json({ ok: true, module: formatModule(row) });
  } catch (e) {
    console.error('DELETE /api/led-modules/:id failed:', e);
    res.status(500).json({ message: 'Delete failed', detail: e.message });
  }
});

module.exports = router;
