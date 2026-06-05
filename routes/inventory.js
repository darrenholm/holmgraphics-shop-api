// routes/inventory.js
// Phase 1 of the inventory + PO system: media products (vinyl SKUs)
// and physical roll instances. The roll-remaining math runs in the
// media_rolls_with_remaining view (see migration 046) so the API
// just SELECTs from it — keeps the formula in one place.

'use strict';

const express = require('express');
const { query, queryOne } = require('../db/connection');
const { requireStaff } = require('../middleware/auth');

const router = express.Router();
router.use(express.json());

function asInt(v) {
  if (v === null || v === undefined || v === '') return null;
  const n = parseInt(v, 10);
  return Number.isInteger(n) ? n : null;
}
function asNumeric(v) {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

// ─── Products (SKU catalog) ──────────────────────────────────────────────

// GET /api/inventory/media/products — every active product with a
// rolled-up roll count and total remaining yards across instances.
router.get('/inventory/media/products', requireStaff, async (req, res, next) => {
  try {
    const includeInactive = req.query.include_inactive === 'true';
    const rows = await query(
      `SELECT p.*,
              COALESCE((SELECT COUNT(*) FROM media_rolls r
                         WHERE r.product_id = p.id AND r.status = 'active'), 0) AS active_rolls,
              COALESCE((SELECT SUM(rwr.remaining_yd) FROM media_rolls_with_remaining rwr
                         WHERE rwr.product_id = p.id AND rwr.status = 'active'), 0) AS total_remaining_yd
         FROM media_products p
        ${includeInactive ? '' : 'WHERE p.active'}
        ORDER BY p.brand, p.product_line, p.color, p.width_in`
    );
    res.json({ products: rows });
  } catch (e) { next(e); }
});

router.get('/inventory/media/products/:id', requireStaff, async (req, res, next) => {
  try {
    const id = asInt(req.params.id);
    if (!id) return res.status(400).json({ message: 'invalid id' });
    const row = await queryOne(`SELECT * FROM media_products WHERE id = $1`, [id]);
    if (!row) return res.status(404).json({ message: 'not found' });
    res.json(row);
  } catch (e) { next(e); }
});

router.post('/inventory/media/products', requireStaff, async (req, res, next) => {
  try {
    const required = ['full_length_yd'];
    for (const k of required) {
      if (req.body[k] == null || req.body[k] === '') {
        return res.status(400).json({ message: `${k} is required` });
      }
    }
    const row = await queryOne(
      `INSERT INTO media_products
         (sku, brand, product_line, color, finish,
          width_in, core_diameter_in, full_length_yd,
          calibration_outer_diameter_in, reorder_threshold_yd,
          supplier, supplier_sku, notes)
       VALUES ($1, $2, $3, $4, $5, $6, COALESCE($7, 3.0), $8, $9, $10, $11, $12, $13)
       RETURNING *`,
      [
        req.body.sku || null, req.body.brand || null,
        req.body.product_line || null, req.body.color || null,
        req.body.finish || null,
        asNumeric(req.body.width_in),
        asNumeric(req.body.core_diameter_in),
        asNumeric(req.body.full_length_yd),
        asNumeric(req.body.calibration_outer_diameter_in),
        asNumeric(req.body.reorder_threshold_yd),
        req.body.supplier || null, req.body.supplier_sku || null,
        req.body.notes || null,
      ]
    );
    res.status(201).json(row);
  } catch (e) { next(e); }
});

router.patch('/inventory/media/products/:id', requireStaff, async (req, res, next) => {
  try {
    const id = asInt(req.params.id);
    if (!id) return res.status(400).json({ message: 'invalid id' });
    const allow = {
      sku: (v) => v ?? null,
      brand: (v) => v ?? null,
      product_line: (v) => v ?? null,
      color: (v) => v ?? null,
      finish: (v) => v ?? null,
      width_in: (v) => asNumeric(v),
      core_diameter_in: (v) => asNumeric(v),
      full_length_yd: (v) => asNumeric(v),
      calibration_outer_diameter_in: (v) => asNumeric(v),
      reorder_threshold_yd: (v) => asNumeric(v),
      supplier: (v) => v ?? null,
      supplier_sku: (v) => v ?? null,
      notes: (v) => v ?? null,
      active: (v) => !!v,
    };
    const fields = [], vals = [];
    for (const [k, coerce] of Object.entries(allow)) {
      if (k in (req.body || {})) {
        fields.push(`${k} = $${fields.length + 1}`);
        vals.push(coerce(req.body[k]));
      }
    }
    if (!fields.length) return res.status(400).json({ message: 'no fields' });
    vals.push(id);
    const row = await queryOne(
      `UPDATE media_products SET ${fields.join(', ')} WHERE id = $${vals.length} RETURNING *`,
      vals
    );
    if (!row) return res.status(404).json({ message: 'not found' });
    res.json(row);
  } catch (e) { next(e); }
});

// ─── Rolls (per-instance state) ─────────────────────────────────────────

// GET /api/inventory/media/rolls — every roll with its computed remaining
// yards via the view. Optional ?product_id=X filter for SKU detail pages.
router.get('/inventory/media/rolls', requireStaff, async (req, res, next) => {
  try {
    const productFilter = asInt(req.query.product_id);
    const includeRetired = req.query.include_retired === 'true';
    const params = [];
    const where = [];
    if (productFilter) {
      params.push(productFilter);
      where.push(`product_id = $${params.length}`);
    }
    if (!includeRetired) {
      where.push(`status != 'retired'`);
    }
    const rows = await query(
      `SELECT rwr.*,
              TRIM(CONCAT_WS(' ', e.first_name, e.last_name)) AS last_measured_by_name,
              -- Flag rolls below the SKU's reorder threshold so the UI
              -- can color-code without a second calculation.
              (rwr.remaining_yd IS NOT NULL
               AND rwr.reorder_threshold_yd IS NOT NULL
               AND rwr.remaining_yd <= rwr.reorder_threshold_yd) AS low_stock
         FROM media_rolls_with_remaining rwr
         LEFT JOIN employees e ON e.id = rwr.last_measured_by
        ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
        ORDER BY rwr.brand, rwr.product_line, rwr.color, rwr.width_in,
                 rwr.location NULLS LAST, rwr.id`,
      params
    );
    res.json({ rolls: rows });
  } catch (e) { next(e); }
});

router.post('/inventory/media/rolls', requireStaff, async (req, res, next) => {
  try {
    const pid = asInt(req.body.product_id);
    if (!pid) return res.status(400).json({ message: 'product_id required' });
    const row = await queryOne(
      `INSERT INTO media_rolls
         (product_id, roll_label, location, notes, status)
       VALUES ($1, $2, $3, $4, COALESCE($5, 'active'))
       RETURNING *`,
      [
        pid, req.body.roll_label || null, req.body.location || null,
        req.body.notes || null, req.body.status,
      ]
    );
    // If they sent an initial measurement on the create, record it too.
    if (asNumeric(req.body.measured_dia_in) != null) {
      await recordMeasurement(row.id, req.body.measured_dia_in, req.user?.id, req.body.notes);
    }
    res.status(201).json(row);
  } catch (e) { next(e); }
});

router.patch('/inventory/media/rolls/:id', requireStaff, async (req, res, next) => {
  try {
    const id = asInt(req.params.id);
    if (!id) return res.status(400).json({ message: 'invalid id' });
    const allow = {
      roll_label: (v) => v ?? null,
      location: (v) => v ?? null,
      notes: (v) => v ?? null,
      status: (v) => v,
    };
    const fields = [], vals = [];
    for (const [k, coerce] of Object.entries(allow)) {
      if (k in (req.body || {})) {
        fields.push(`${k} = $${fields.length + 1}`);
        vals.push(coerce(req.body[k]));
      }
    }
    if (!fields.length) return res.status(400).json({ message: 'no fields' });
    vals.push(id);
    const row = await queryOne(
      `UPDATE media_rolls SET ${fields.join(', ')} WHERE id = $${vals.length} RETURNING *`,
      vals
    );
    if (!row) return res.status(404).json({ message: 'not found' });
    res.json(row);
  } catch (e) { next(e); }
});

// POST /api/inventory/media/rolls/:id/measure — record a fresh diameter.
// Updates the denormalised last_measured_* fields on the roll AND inserts
// a measurement history row. Returns the roll with its recomputed
// remaining_yd so the UI can refresh in place.
async function recordMeasurement(rollId, diameter, userId, notes) {
  const dia = asNumeric(diameter);
  if (dia == null) throw new Error('measured_dia_in is required');

  // Compute remaining_yd inline so we can snapshot it in the history row.
  const product = await queryOne(
    `SELECT p.full_length_yd, p.core_diameter_in, p.calibration_outer_diameter_in
       FROM media_products p
       JOIN media_rolls r ON r.product_id = p.id
      WHERE r.id = $1`,
    [rollId]
  );
  let computed = null;
  if (product && product.calibration_outer_diameter_in != null) {
    const cal = Number(product.calibration_outer_diameter_in);
    const core = Number(product.core_diameter_in);
    const denom = (cal * cal) - (core * core);
    if (denom > 0) {
      if (dia <= core) computed = 0;
      else {
        const ratio = ((dia * dia) - (core * core)) / denom;
        computed = Math.round(Number(product.full_length_yd) * ratio * 100) / 100;
      }
    }
  }

  await query(
    `INSERT INTO media_roll_measurements
       (roll_id, measured_dia_in, computed_remaining_yd, measured_by, notes)
     VALUES ($1, $2, $3, $4, $5)`,
    [rollId, dia, computed, userId || null, notes || null]
  );
  await query(
    `UPDATE media_rolls
        SET last_measured_dia_in = $1,
            last_measured_at     = NOW(),
            last_measured_by     = $2
      WHERE id = $3`,
    [dia, userId || null, rollId]
  );
  return computed;
}

router.post('/inventory/media/rolls/:id/measure', requireStaff, async (req, res, next) => {
  try {
    const id = asInt(req.params.id);
    if (!id) return res.status(400).json({ message: 'invalid id' });
    if (asNumeric(req.body?.measured_dia_in) == null) {
      return res.status(400).json({ message: 'measured_dia_in required' });
    }
    await recordMeasurement(id, req.body.measured_dia_in, req.user?.id, req.body.notes);
    const row = await queryOne(
      `SELECT rwr.* FROM media_rolls_with_remaining rwr WHERE id = $1`,
      [id]
    );
    res.json(row);
  } catch (e) { next(e); }
});

// GET /api/inventory/media/rolls/:id/measurements — measurement history.
router.get('/inventory/media/rolls/:id/measurements', requireStaff, async (req, res, next) => {
  try {
    const id = asInt(req.params.id);
    if (!id) return res.status(400).json({ message: 'invalid id' });
    const rows = await query(
      `SELECT m.*,
              TRIM(CONCAT_WS(' ', e.first_name, e.last_name)) AS measured_by_name
         FROM media_roll_measurements m
         LEFT JOIN employees e ON e.id = m.measured_by
        WHERE m.roll_id = $1
        ORDER BY m.measured_at DESC`,
      [id]
    );
    res.json({ measurements: rows });
  } catch (e) { next(e); }
});

// DELETE /api/inventory/media/rolls/:id — typical "retired roll" or
// data-entry mistake. Soft-retire instead of hard delete since the
// measurement history is a useful audit trail.
router.delete('/inventory/media/rolls/:id', requireStaff, async (req, res, next) => {
  try {
    const id = asInt(req.params.id);
    if (!id) return res.status(400).json({ message: 'invalid id' });
    await query(`UPDATE media_rolls SET status = 'retired' WHERE id = $1`, [id]);
    res.status(204).end();
  } catch (e) { next(e); }
});

module.exports = router;
