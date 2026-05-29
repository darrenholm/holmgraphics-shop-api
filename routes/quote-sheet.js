// routes/quote-sheet.js
// Internal quoting worksheet attached to a project. CRUD on
// quote_sheet_items + a "promote" action that copies the sheet into
// the customer-facing `items` table at sale price.
//
// Mounted in server.js as `app.use('/api', quoteSheetRoutes)` so the
// routes read /api/projects/:id/quote-sheet etc.

'use strict';

const express = require('express');
const { query, queryOne } = require('../db/connection');
const { requireStaff } = require('../middleware/auth');

const router = express.Router();

function projectIdOrBail(req, res) {
  const id = parseInt(req.params.id, 10);
  if (!Number.isInteger(id) || id <= 0) {
    res.status(400).json({ message: 'invalid project id' });
    return null;
  }
  return id;
}

function num(v) {
  const n = parseFloat(v);
  return Number.isFinite(n) ? n : null;
}

// ─── GET /api/projects/:id/quote-sheet ────────────────────────────────────
// List rows for one project, in display order.
router.get('/projects/:id/quote-sheet', requireStaff, async (req, res, next) => {
  try {
    const projectId = projectIdOrBail(req, res);
    if (projectId == null) return;
    const rows = await query(
      `SELECT id, project_id, item, qty, cost_per_unit, markup, sale_per_unit,
              notes, position, created_at, updated_at
         FROM quote_sheet_items
        WHERE project_id = $1
        ORDER BY position, id`,
      [projectId]
    );
    res.json({ rows });
  } catch (err) { next(err); }
});

// ─── POST /api/projects/:id/quote-sheet ───────────────────────────────────
// Add a new row. Body fields are all optional — defaults match the table.
router.post('/projects/:id/quote-sheet', requireStaff, async (req, res, next) => {
  try {
    const projectId = projectIdOrBail(req, res);
    if (projectId == null) return;
    const b = req.body || {};
    const last = await queryOne(
      `SELECT COALESCE(MAX(position), -1) AS pos FROM quote_sheet_items WHERE project_id = $1`,
      [projectId]
    );
    const row = await queryOne(
      `INSERT INTO quote_sheet_items
         (project_id, item, qty, cost_per_unit, markup, sale_per_unit, notes, position)
       VALUES ($1, $2, COALESCE($3, 1), COALESCE($4, 0), COALESCE($5, 2),
               COALESCE($6, 0), $7, $8)
       RETURNING id, project_id, item, qty, cost_per_unit, markup, sale_per_unit,
                 notes, position, created_at, updated_at`,
      [
        projectId,
        String(b.item || ''),
        num(b.qty),
        num(b.cost_per_unit),
        num(b.markup),
        num(b.sale_per_unit),
        b.notes ? String(b.notes) : null,
        Number(last.pos) + 1
      ]
    );
    res.status(201).json(row);
  } catch (err) { next(err); }
});

// ─── PATCH /api/projects/:id/quote-sheet/:rowId ──────────────────────────
// Partial update. Only fields present in the body are touched.
router.patch('/projects/:id/quote-sheet/:rowId', requireStaff, async (req, res, next) => {
  try {
    const projectId = projectIdOrBail(req, res);
    if (projectId == null) return;
    const rowId = parseInt(req.params.rowId, 10);
    if (!Number.isInteger(rowId) || rowId <= 0) return res.status(400).json({ message: 'invalid row id' });
    const b = req.body || {};

    const sets = [];
    const args = [];
    let i = 1;
    if (b.item !== undefined)          { sets.push(`item = $${i++}`); args.push(String(b.item || '')); }
    if (b.qty !== undefined)           { sets.push(`qty = $${i++}`); args.push(num(b.qty) ?? 1); }
    if (b.cost_per_unit !== undefined) { sets.push(`cost_per_unit = $${i++}`); args.push(num(b.cost_per_unit) ?? 0); }
    if (b.markup !== undefined)        { sets.push(`markup = $${i++}`); args.push(num(b.markup) ?? 2); }
    if (b.sale_per_unit !== undefined) { sets.push(`sale_per_unit = $${i++}`); args.push(num(b.sale_per_unit) ?? 0); }
    if (b.notes !== undefined)         { sets.push(`notes = $${i++}`); args.push(b.notes ? String(b.notes) : null); }
    if (b.position !== undefined)      { sets.push(`position = $${i++}`); args.push(parseInt(b.position, 10) || 0); }
    if (sets.length === 0) return res.status(400).json({ message: 'no fields to update' });
    sets.push(`updated_at = NOW()`);
    args.push(rowId, projectId);

    const row = await queryOne(
      `UPDATE quote_sheet_items
          SET ${sets.join(', ')}
        WHERE id = $${i++} AND project_id = $${i}
        RETURNING id, project_id, item, qty, cost_per_unit, markup, sale_per_unit,
                  notes, position, created_at, updated_at`,
      args
    );
    if (!row) return res.status(404).json({ message: 'row not found' });
    res.json(row);
  } catch (err) { next(err); }
});

// ─── DELETE /api/projects/:id/quote-sheet/:rowId ─────────────────────────
router.delete('/projects/:id/quote-sheet/:rowId', requireStaff, async (req, res, next) => {
  try {
    const projectId = projectIdOrBail(req, res);
    if (projectId == null) return;
    const rowId = parseInt(req.params.rowId, 10);
    if (!Number.isInteger(rowId) || rowId <= 0) return res.status(400).json({ message: 'invalid row id' });
    await query(
      `DELETE FROM quote_sheet_items WHERE id = $1 AND project_id = $2`,
      [rowId, projectId]
    );
    res.status(204).end();
  } catch (err) { next(err); }
});

// ─── POST /api/projects/:id/quote-sheet/promote ──────────────────────────
// Copy every row into the customer-facing `items` table at sale price.
// Returns { inserted } so the UI can confirm. Idempotent only in that
// repeated calls just keep adding duplicates — staff should review the
// items tab afterward and delete the quote rows if they don't want them.
router.post('/projects/:id/quote-sheet/promote', requireStaff, async (req, res, next) => {
  try {
    const projectId = projectIdOrBail(req, res);
    if (projectId == null) return;
    const rows = await query(
      `SELECT item, qty, sale_per_unit
         FROM quote_sheet_items
        WHERE project_id = $1
        ORDER BY position, id`,
      [projectId]
    );
    if (rows.length === 0) return res.status(400).json({ message: 'no quote rows to promote' });
    let inserted = 0;
    for (const r of rows) {
      const qty   = parseFloat(r.qty) || 0;
      const price = parseFloat(r.sale_per_unit) || 0;
      const total = qty * price;
      await query(
        `INSERT INTO items (project_id, description, qty, price, ext_price)
         VALUES ($1, $2, $3, $4, $5)`,
        [projectId, r.item || '(unnamed)', qty, price, total]
      );
      inserted++;
    }
    res.json({ inserted });
  } catch (err) { next(err); }
});

module.exports = router;
