// routes/dtf-admin.js
// Staff-only CRUD for DTF pricing configuration. Mounted at /api/admin/dtf
// behind requireAdmin so only admins can change prices.
//
// Tables managed:
//   - print_locations
//   - print_location_prices
//   - dtf_custom_tiers
//   - tax_rates
//
// Any mutation calls bustCache() so changes go live on the next quote
// without waiting for the 60s TTL.

'use strict';

const express = require('express');
const { query, queryOne } = require('../db/connection');
const { requireAdmin } = require('../middleware/auth');
const { bustCache } = require('../lib/dtf-pricing-loader');

const router = express.Router();

router.use(requireAdmin);

// ─── Print locations ─────────────────────────────────────────────────────────

router.get('/print-locations', async (req, res) => {
  try {
    const rows = await query(
      `SELECT * FROM print_locations ORDER BY garment_category, display_order, name`
    );
    res.json({ print_locations: rows });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/print-locations', async (req, res) => {
  try {
    const { garment_category, name, max_width_in, max_height_in, display_order, active } = req.body;
    if (!garment_category || !name) return res.status(400).json({ error: 'garment_category and name required' });
    const row = await queryOne(
      `INSERT INTO print_locations (garment_category, name, max_width_in, max_height_in, display_order, active)
            VALUES ($1, $2, $3, $4, $5, $6)
         RETURNING *`,
      [garment_category, name, max_width_in || 0, max_height_in || 0, display_order || 0, active !== false]
    );
    bustCache();
    res.status(201).json({ print_location: row });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.put('/print-locations/:id', async (req, res) => {
  try {
    const fields = {};
    for (const k of ['garment_category','name','max_width_in','max_height_in','display_order','active']) {
      if (req.body[k] !== undefined) fields[k] = req.body[k];
    }
    if (!Object.keys(fields).length) return res.status(400).json({ error: 'No fields to update' });
    const sets = Object.keys(fields).map((k, i) => `${k} = $${i + 1}`).join(', ');
    const row = await queryOne(
      `UPDATE print_locations SET ${sets} WHERE id = $${Object.keys(fields).length + 1} RETURNING *`,
      [...Object.values(fields), req.params.id]
    );
    if (!row) return res.status(404).json({ error: 'Print location not found' });
    bustCache();
    res.json({ print_location: row });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.delete('/print-locations/:id', async (req, res) => {
  try {
    // Soft-delete: just mark inactive so historical orders that reference
    // it still work.
    const row = await queryOne(
      `UPDATE print_locations SET active = FALSE WHERE id = $1 RETURNING id`,
      [req.params.id]
    );
    if (!row) return res.status(404).json({ error: 'Not found' });
    bustCache();
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Print location prices (tiers) ───────────────────────────────────────────

router.get('/print-location-prices/:locationId', async (req, res) => {
  try {
    const rows = await query(
      `SELECT * FROM print_location_prices WHERE print_location_id = $1 ORDER BY min_quantity`,
      [req.params.locationId]
    );
    res.json({ tiers: rows });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// PUT /api/admin/dtf/print-location-prices/:locationId  — replaces all tiers atomically
router.put('/print-location-prices/:locationId', async (req, res) => {
  try {
    const { tiers } = req.body;
    if (!Array.isArray(tiers)) return res.status(400).json({ error: 'tiers array required' });

    // Single transaction: wipe + reinsert.
    const { pool } = require('../db/connection');
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(`DELETE FROM print_location_prices WHERE print_location_id = $1`, [req.params.locationId]);
      for (const t of tiers) {
        await client.query(
          `INSERT INTO print_location_prices (print_location_id, min_quantity, max_quantity, price_per_piece)
                VALUES ($1, $2, $3, $4)`,
          [req.params.locationId, t.min_quantity, t.max_quantity ?? null, t.price_per_piece]
        );
      }
      await client.query('COMMIT');
    } catch (e) {
      await client.query('ROLLBACK');
      throw e;
    } finally {
      client.release();
    }
    bustCache();
    const updated = await query(
      `SELECT * FROM print_location_prices WHERE print_location_id = $1 ORDER BY min_quantity`,
      [req.params.locationId]
    );
    res.json({ tiers: updated });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── DTF custom tiers ────────────────────────────────────────────────────────

router.get('/custom-tiers', async (req, res) => {
  try {
    const rows = await query(`SELECT * FROM dtf_custom_tiers ORDER BY min_quantity`);
    res.json({ tiers: rows });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.put('/custom-tiers', async (req, res) => {
  try {
    const { tiers } = req.body;
    if (!Array.isArray(tiers)) return res.status(400).json({ error: 'tiers array required' });
    const { pool } = require('../db/connection');
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(`DELETE FROM dtf_custom_tiers`);
      for (const t of tiers) {
        await client.query(
          `INSERT INTO dtf_custom_tiers (min_quantity, max_quantity, price_per_sqin, min_per_piece, setup_fee_per_design)
                VALUES ($1, $2, $3, $4, $5)`,
          [t.min_quantity, t.max_quantity ?? null, t.price_per_sqin, t.min_per_piece || 0, t.setup_fee_per_design || 0]
        );
      }
      await client.query('COMMIT');
    } catch (e) {
      await client.query('ROLLBACK');
      throw e;
    } finally {
      client.release();
    }
    bustCache();
    const updated = await query(`SELECT * FROM dtf_custom_tiers ORDER BY min_quantity`);
    res.json({ tiers: updated });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Tax rates ───────────────────────────────────────────────────────────────

router.put('/tax-rates/:province', async (req, res) => {
  try {
    const { rate, rate_label } = req.body;
    if (typeof rate !== 'number') return res.status(400).json({ error: 'rate (number) required' });
    const row = await queryOne(
      `UPDATE tax_rates SET rate = $1, rate_label = COALESCE($2, rate_label),
              updated_at = NOW()
        WHERE province_code = $3
        RETURNING *`,
      [rate, rate_label || null, req.params.province.toUpperCase()]
    );
    if (!row) return res.status(404).json({ error: 'Province not found' });
    bustCache();
    res.json({ tax_rate: row });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
