// routes/fleet.js
// Vehicle Documents Portal API.
//
// Mounted at /api/fleet by server.js. All endpoints require staff JWT
// (requireStaff covers role='staff' and role='admin'); drivers are staff.
//
// This file ships incrementally per the build spec. Step 2 covers the
// authenticated streaming endpoint only — uploads, vehicle CRUD, expiry
// monitoring, and the access-log query endpoint land in Steps 3–5.
//
// Streaming contract:
//   GET /api/fleet/documents/:id/file
//     → 200 with the file body, Content-Type set, Content-Disposition: inline
//       so PDFs render in-page and images preview in the browser.
//   GET /api/fleet/documents/:id/file?download=1
//     → same content, Content-Disposition: attachment. Logged as 'download'.
//
// Audit: every GET writes a row into fleet_document_access_log BEFORE the
// stream starts. If the stream errors mid-flight (network drop, file
// missing), the log row is still there — that's intentional. CVOR-style
// audits care about *attempted* access, not whether the bytes finished.

'use strict';

const express = require('express');
const multer  = require('multer');
const { queryOne, query, pool } = require('../db/connection');
const { requireStaff } = require('../middleware/auth');
const storage = require('../lib/fleet-storage');

const router = express.Router();

// Multer is used only for parsing the multipart body — files stay in memory
// just long enough for storage.saveDocument to validate + write them to
// the volume. fileSize limit catches oversize uploads before fully
// buffering into memory; storage.saveDocument enforces the same limit as
// a second line of defence.
const upload = multer({
  storage: multer.memoryStorage(),
  limits:  { fileSize: storage.MAX_BYTES }
});

// Per-vehicle document types. CVOR moved to the operator-level table
// (fleet_operator_documents) in migration 027 — it's issued to the
// business, not individual vehicles.
const DOC_TYPES = ['ownership', 'insurance', 'inspection'];

// Operator-level document types — currently just CVOR, but the table
// and code paths accommodate adding more (operating authority,
// liability cert, etc).
const OPERATOR_DOC_TYPES = ['cvor'];

function statusForDoc(doc) {
  if (!doc || !doc.id) return 'missing';
  if (!doc.expiry_date) return 'valid';
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const expiry = new Date(doc.expiry_date);
  const days = Math.floor((expiry.getTime() - today.getTime()) / 86400000);
  if (days < 0)  return 'expired';
  if (days <= 30) return 'expiring_soon';
  return 'valid';
}

function isISODate(s) {
  return typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s);
}

// ─── helpers ─────────────────────────────────────────────────────────────────

function ipOf(req) {
  // Trust X-Forwarded-For only one hop (Railway's edge). app.set('trust proxy')
  // in server.js would also handle this; explicit fallback keeps behaviour
  // sensible whether or not trust proxy is enabled.
  const xff = req.headers['x-forwarded-for'];
  if (typeof xff === 'string' && xff.length > 0) return xff.split(',')[0].trim();
  return req.ip || req.socket?.remoteAddress || null;
}

async function logAccess({ userId, documentId, action, source = 'vehicle', req }) {
  try {
    await query(
      `INSERT INTO fleet_document_access_log
         (user_id, document_id, action, ip_address, user_agent, source)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [
        userId,
        documentId,
        action,
        ipOf(req),
        (req.headers['user-agent'] || '').slice(0, 500) || null,
        source
      ]
    );
  } catch (e) {
    // Logging is critical for CVOR posture, but a failed log row must not
    // block the driver from showing the document to an officer. Surface
    // the failure to server logs and continue.
    console.warn(`[fleet] access log insert failed for doc ${documentId} (${source}):`, e.message);
  }
}

// ─── GET /documents/:id/file ─────────────────────────────────────────────────

router.get('/documents/:id/file', requireStaff, async (req, res, next) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (!Number.isInteger(id) || id <= 0) {
      return res.status(400).json({ message: 'invalid document id' });
    }

    const doc = await queryOne(
      `SELECT id, vehicle_id, doc_type, file_path, file_mime, file_size_bytes
         FROM fleet_documents
        WHERE id = $1`,
      [id]
    );
    if (!doc) return res.status(404).json({ message: 'document not found' });

    // Confirm the bytes actually exist on disk before logging a successful
    // attempt — 404 here means a corrupt DB row (file_path points at
    // nothing), which is more useful than a half-streamed response.
    let stat;
    try {
      stat = await storage.statDocument(doc.file_path);
    } catch (e) {
      console.warn(`[fleet] file missing on disk for doc ${id} (${doc.file_path}):`, e.message);
      return res.status(404).json({ message: 'document file missing on storage' });
    }

    const download = req.query.download === '1' || req.query.download === 'true';
    await logAccess({
      userId:     req.user.id,
      documentId: doc.id,
      action:     download ? 'download' : 'view',
      req
    });

    res.setHeader('Content-Type',   doc.file_mime);
    res.setHeader('Content-Length', stat.size);
    res.setHeader('Cache-Control',  'private, no-store');   // never CDN-cache fleet docs
    res.setHeader('Content-Disposition',
      download
        ? `attachment; filename="fleet-${doc.vehicle_id}-${doc.doc_type}-${doc.id}.${doc.file_path.split('.').pop()}"`
        : 'inline'
    );

    const stream = storage.streamDocument(doc.file_path);
    stream.on('error', (err) => {
      console.warn(`[fleet] stream error for doc ${id}:`, err.message);
      if (!res.headersSent) res.status(500);
      res.end();
    });
    stream.pipe(res);
  } catch (err) { next(err); }
});

// ─── GET /vehicles  — list + per-doc-type status summary ────────────────────

router.get('/vehicles', requireStaff, async (req, res, next) => {
  try {
    const includeInactive = req.query.include_inactive === '1' || req.query.include_inactive === 'true';
    const rows = await query(
      `SELECT v.id, v.unit_number, v.type, v.make, v.model, v.year,
              v.license_plate, v.vin, v.notes, v.active,
              v.created_at, v.updated_at,
              o.id AS o_id, o.expiry_date AS o_expiry,
              i.id AS i_id, i.expiry_date AS i_expiry,
              n.id AS n_id, n.expiry_date AS n_expiry
         FROM vehicles v
         LEFT JOIN fleet_documents o
           ON o.vehicle_id = v.id AND o.doc_type = 'ownership' AND o.is_current = TRUE
         LEFT JOIN fleet_documents i
           ON i.vehicle_id = v.id AND i.doc_type = 'insurance' AND i.is_current = TRUE
         LEFT JOIN fleet_documents n
           ON n.vehicle_id = v.id AND n.doc_type = 'inspection' AND n.is_current = TRUE
        ${includeInactive ? '' : 'WHERE v.active = TRUE'}
        ORDER BY v.unit_number`
    );
    const vehicles = rows.map((r) => ({
      id: r.id,
      unit_number: r.unit_number,
      type: r.type,
      make: r.make, model: r.model, year: r.year,
      license_plate: r.license_plate,
      vin: r.vin,
      notes: r.notes,
      active: r.active,
      created_at: r.created_at,
      updated_at: r.updated_at,
      documents: {
        ownership:  { id: r.o_id, expiry_date: r.o_expiry, status: statusForDoc({ id: r.o_id, expiry_date: r.o_expiry }) },
        insurance:  { id: r.i_id, expiry_date: r.i_expiry, status: statusForDoc({ id: r.i_id, expiry_date: r.i_expiry }) },
        inspection: { id: r.n_id, expiry_date: r.n_expiry, status: statusForDoc({ id: r.n_id, expiry_date: r.n_expiry }) }
      }
    }));
    res.json({ vehicles });
  } catch (err) { next(err); }
});

// ─── POST /vehicles  — create ────────────────────────────────────────────────

router.post('/vehicles', requireStaff, async (req, res, next) => {
  try {
    const b = req.body || {};
    const unit_number = (b.unit_number || '').trim();
    const type        = (b.type || '').trim();
    if (!unit_number) return res.status(400).json({ message: 'unit_number required' });
    if (!['truck', 'trailer'].includes(type)) return res.status(400).json({ message: "type must be 'truck' or 'trailer'" });

    const year = b.year ? parseInt(b.year, 10) : null;
    if (year != null && (Number.isNaN(year) || year < 1900 || year > 2099)) {
      return res.status(400).json({ message: 'year out of range' });
    }

    const row = await queryOne(
      `INSERT INTO vehicles (unit_number, type, make, model, year, license_plate, vin, notes, active)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, COALESCE($9, TRUE))
       RETURNING id, unit_number, type, make, model, year, license_plate, vin, notes, active, created_at, updated_at`,
      [
        unit_number, type,
        b.make || null, b.model || null, year,
        b.license_plate || null, b.vin || null, b.notes || null,
        b.active == null ? null : !!b.active
      ]
    );
    res.status(201).json(row);
  } catch (err) {
    if (err.code === '23505') return res.status(409).json({ message: 'A vehicle with that unit number already exists.' });
    next(err);
  }
});

// ─── GET /vehicles/by-unit/:unit_number  — driver-facing lookup ─────────────
// Drivers navigate to /fleet-docs/{unit_number} which is more memorable than
// an opaque numeric id. This endpoint mirrors GET /vehicles/:id but keys on
// the unit_number (case-insensitive) instead.

router.get('/vehicles/by-unit/:unit_number', requireStaff, async (req, res, next) => {
  try {
    const unit = (req.params.unit_number || '').trim();
    if (!unit) return res.status(400).json({ message: 'unit_number required' });
    const v = await queryOne(
      `SELECT id FROM vehicles WHERE UPPER(unit_number) = UPPER($1)`,
      [unit]
    );
    if (!v) return res.status(404).json({ message: 'vehicle not found' });
    // Delegate to the same handler by overwriting params.
    req.params.id = String(v.id);
    return vehicleDetailHandler(req, res, next);
  } catch (err) { next(err); }
});

// ─── GET /vehicles/:id  — detail + current docs + history ────────────────────

router.get('/vehicles/:id', requireStaff, (req, res, next) => vehicleDetailHandler(req, res, next));

async function vehicleDetailHandler(req, res, next) {
  try {
    const id = parseInt(req.params.id, 10);
    if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ message: 'invalid id' });

    const vehicle = await queryOne(
      `SELECT id, unit_number, type, make, model, year, license_plate, vin,
              notes, active, created_at, updated_at
         FROM vehicles WHERE id = $1`,
      [id]
    );
    if (!vehicle) return res.status(404).json({ message: 'vehicle not found' });

    const docs = await query(
      `SELECT d.id, d.doc_type, d.file_mime, d.file_size_bytes,
              d.issued_date, d.expiry_date, d.uploaded_at, d.is_current, d.notes,
              d.uploaded_by,
              (e.first_name || ' ' || e.last_name) AS uploaded_by_name,
              e.email AS uploaded_by_email
         FROM fleet_documents d
         LEFT JOIN employees e ON e.id = d.uploaded_by
        WHERE d.vehicle_id = $1
        ORDER BY d.uploaded_at DESC`,
      [id]
    );

    const grouped = { ownership:  { current: null, history: [] },
                      insurance:  { current: null, history: [] },
                      inspection: { current: null, history: [] } };
    for (const d of docs) {
      // Legacy per-vehicle CVOR rows (retired by migration 027) are no
      // longer surfaced here — skip them so the UI sees CVOR only via
      // the operator-documents endpoint.
      if (!grouped[d.doc_type]) continue;
      const stat = statusForDoc(d);
      const entry = { ...d, status: stat };
      if (d.is_current) grouped[d.doc_type].current = entry;
      else              grouped[d.doc_type].history.push(entry);
    }

    res.json({ vehicle, documents: grouped });
  } catch (err) { next(err); }
}

// ─── PATCH /vehicles/:id  — update mutable fields ───────────────────────────

router.patch('/vehicles/:id', requireStaff, async (req, res, next) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ message: 'invalid id' });
    const b = req.body || {};

    const sets = [];
    const args = [];
    let i = 1;
    const fields = ['unit_number', 'type', 'make', 'model', 'year', 'license_plate', 'vin', 'notes', 'active'];
    for (const f of fields) {
      if (b[f] === undefined) continue;
      if (f === 'type' && !['truck', 'trailer'].includes(b[f])) {
        return res.status(400).json({ message: "type must be 'truck' or 'trailer'" });
      }
      if (f === 'year' && b.year != null) {
        const y = parseInt(b.year, 10);
        if (Number.isNaN(y) || y < 1900 || y > 2099) return res.status(400).json({ message: 'year out of range' });
        sets.push(`year = $${i++}`); args.push(y);
        continue;
      }
      sets.push(`${f} = $${i++}`); args.push(b[f]);
    }
    if (sets.length === 0) return res.status(400).json({ message: 'no fields to update' });
    args.push(id);

    const row = await queryOne(
      `UPDATE vehicles SET ${sets.join(', ')} WHERE id = $${i}
       RETURNING id, unit_number, type, make, model, year, license_plate, vin, notes, active, created_at, updated_at`,
      args
    );
    if (!row) return res.status(404).json({ message: 'vehicle not found' });
    res.json(row);
  } catch (err) {
    if (err.code === '23505') return res.status(409).json({ message: 'A vehicle with that unit number already exists.' });
    next(err);
  }
});

// ─── POST /vehicles/:id/documents  — multipart upload (new "current") ───────

router.post('/vehicles/:id/documents', requireStaff, (req, res, next) => {
  upload.single('file')(req, res, (err) => {
    if (err) {
      if (err.code === 'LIMIT_FILE_SIZE')
        return res.status(413).json({ message: 'File too large, please send via email after submitting.' });
      return next(err);
    }
    handleUpload(req, res).catch(next);
  });
});

async function handleUpload(req, res) {
  const vehicleId = parseInt(req.params.id, 10);
  if (!Number.isInteger(vehicleId) || vehicleId <= 0) return res.status(400).json({ message: 'invalid vehicle id' });

  const file = req.file;
  if (!file) return res.status(400).json({ message: 'file required (multipart field "file")' });

  const doc_type    = (req.body.doc_type || '').trim();
  const issued_date = req.body.issued_date || null;
  const expiry_date = req.body.expiry_date || null;
  const notes       = req.body.notes || null;
  if (!DOC_TYPES.includes(doc_type)) return res.status(400).json({ message: 'invalid doc_type' });
  if (issued_date && !isISODate(issued_date)) return res.status(400).json({ message: 'issued_date must be YYYY-MM-DD' });
  if (expiry_date && !isISODate(expiry_date)) return res.status(400).json({ message: 'expiry_date must be YYYY-MM-DD' });

  const vehicle = await queryOne(`SELECT id, type FROM vehicles WHERE id = $1`, [vehicleId]);
  if (!vehicle) return res.status(404).json({ message: 'vehicle not found' });

  if (issued_date) {
    const today = new Date(); today.setHours(0,0,0,0);
    if (new Date(issued_date) > today) {
      return res.status(400).json({ message: 'Issued date cannot be in the future.' });
    }
  }
  if (issued_date && expiry_date && new Date(expiry_date) < new Date(issued_date)) {
    return res.status(400).json({ message: 'Expiry date cannot be before issued date.' });
  }

  // Write the file to the volume first; if the DB transaction fails after
  // this, the orphaned file is cleaned up in the catch.
  let saved;
  try {
    saved = await storage.saveDocument({
      vehicleId, docType: doc_type, buffer: file.buffer, mime: file.mimetype
    });
  } catch (e) {
    if (e.code === 'FILE_TOO_LARGE')   return res.status(413).json({ message: e.message });
    if (e.code === 'UNSUPPORTED_MIME') return res.status(415).json({ message: e.message });
    throw e;
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(
      `UPDATE fleet_documents
          SET is_current = FALSE
        WHERE vehicle_id = $1 AND doc_type = $2 AND is_current = TRUE`,
      [vehicleId, doc_type]
    );
    const ins = await client.query(
      `INSERT INTO fleet_documents
         (vehicle_id, doc_type, file_path, file_mime, file_size_bytes,
          issued_date, expiry_date, uploaded_by, notes, is_current)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, TRUE)
       RETURNING id, uploaded_at`,
      [
        vehicleId, doc_type,
        saved.file_path, saved.file_mime, saved.file_size_bytes,
        issued_date, expiry_date,
        req.user.id, notes
      ]
    );
    await client.query('COMMIT');
    res.status(201).json({
      id:           ins.rows[0].id,
      uploaded_at:  ins.rows[0].uploaded_at,
      doc_type,
      file_mime:    saved.file_mime,
      file_size_bytes: saved.file_size_bytes,
      issued_date, expiry_date,
      status:       statusForDoc({ id: ins.rows[0].id, expiry_date })
    });
  } catch (e) {
    try { await client.query('ROLLBACK'); } catch {}
    try { await storage.deleteDocument(saved.file_path); } catch {}
    throw e;
  } finally {
    client.release();
  }
}

// ─── Operator-level documents (CVOR etc) ───────────────────────────────────
// CVOR is issued to the BUSINESS, not individual vehicles — one current
// CVOR covers the whole fleet. These endpoints mirror the per-vehicle
// document API but against fleet_operator_documents.

// GET /operator-documents — current + history grouped by doc_type.
router.get('/operator-documents', requireStaff, async (req, res, next) => {
  try {
    const docs = await query(
      `SELECT d.id, d.doc_type, d.file_mime, d.file_size_bytes,
              d.issued_date, d.expiry_date, d.uploaded_at, d.is_current, d.notes,
              d.uploaded_by,
              (e.first_name || ' ' || e.last_name) AS uploaded_by_name,
              e.email AS uploaded_by_email
         FROM fleet_operator_documents d
         LEFT JOIN employees e ON e.id = d.uploaded_by
        ORDER BY d.uploaded_at DESC`
    );
    const grouped = {};
    for (const t of OPERATOR_DOC_TYPES) grouped[t] = { current: null, history: [] };
    for (const d of docs) {
      if (!grouped[d.doc_type]) continue;
      const entry = { ...d, status: statusForDoc(d) };
      if (d.is_current) grouped[d.doc_type].current = entry;
      else              grouped[d.doc_type].history.push(entry);
    }
    res.json({ documents: grouped });
  } catch (err) { next(err); }
});

// POST /operator-documents — multipart upload (new "current").
router.post('/operator-documents', requireStaff, (req, res, next) => {
  upload.single('file')(req, res, (err) => {
    if (err) {
      if (err.code === 'LIMIT_FILE_SIZE')
        return res.status(413).json({ message: 'File too large, please send via email after submitting.' });
      return next(err);
    }
    handleOperatorUpload(req, res).catch(next);
  });
});

async function handleOperatorUpload(req, res) {
  const file = req.file;
  if (!file) return res.status(400).json({ message: 'file required (multipart field "file")' });

  const doc_type    = (req.body.doc_type || '').trim();
  const issued_date = req.body.issued_date || null;
  const expiry_date = req.body.expiry_date || null;
  const notes       = req.body.notes || null;
  if (!OPERATOR_DOC_TYPES.includes(doc_type)) return res.status(400).json({ message: 'invalid doc_type' });
  if (issued_date && !isISODate(issued_date)) return res.status(400).json({ message: 'issued_date must be YYYY-MM-DD' });
  if (expiry_date && !isISODate(expiry_date)) return res.status(400).json({ message: 'expiry_date must be YYYY-MM-DD' });

  if (issued_date) {
    const today = new Date(); today.setHours(0,0,0,0);
    if (new Date(issued_date) > today) {
      return res.status(400).json({ message: 'Issued date cannot be in the future.' });
    }
  }
  if (issued_date && expiry_date && new Date(expiry_date) < new Date(issued_date)) {
    return res.status(400).json({ message: 'Expiry date cannot be before issued date.' });
  }

  let saved;
  try {
    saved = await storage.saveOperatorDocument({
      docType: doc_type, buffer: file.buffer, mime: file.mimetype
    });
  } catch (e) {
    if (e.code === 'FILE_TOO_LARGE')   return res.status(413).json({ message: e.message });
    if (e.code === 'UNSUPPORTED_MIME') return res.status(415).json({ message: e.message });
    throw e;
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(
      `UPDATE fleet_operator_documents
          SET is_current = FALSE
        WHERE doc_type = $1 AND is_current = TRUE`,
      [doc_type]
    );
    const ins = await client.query(
      `INSERT INTO fleet_operator_documents
         (doc_type, file_path, file_mime, file_size_bytes,
          issued_date, expiry_date, uploaded_by, notes, is_current)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, TRUE)
       RETURNING id, uploaded_at`,
      [
        doc_type, saved.file_path, saved.file_mime, saved.file_size_bytes,
        issued_date, expiry_date, req.user.id, notes
      ]
    );
    await client.query('COMMIT');
    res.status(201).json({
      id:           ins.rows[0].id,
      uploaded_at:  ins.rows[0].uploaded_at,
      doc_type,
      file_mime:    saved.file_mime,
      file_size_bytes: saved.file_size_bytes,
      issued_date, expiry_date,
      status:       statusForDoc({ id: ins.rows[0].id, expiry_date })
    });
  } catch (e) {
    try { await client.query('ROLLBACK'); } catch {}
    try { await storage.deleteDocument(saved.file_path); } catch {}
    throw e;
  } finally {
    client.release();
  }
}

// GET /operator-documents/:id/file — stream + access-log.
router.get('/operator-documents/:id/file', requireStaff, async (req, res, next) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (!Number.isInteger(id) || id <= 0) {
      return res.status(400).json({ message: 'invalid document id' });
    }

    const doc = await queryOne(
      `SELECT id, doc_type, file_path, file_mime, file_size_bytes
         FROM fleet_operator_documents
        WHERE id = $1`,
      [id]
    );
    if (!doc) return res.status(404).json({ message: 'document not found' });

    let stat;
    try {
      stat = await storage.statDocument(doc.file_path);
    } catch (e) {
      console.warn(`[fleet] operator file missing on disk for doc ${id} (${doc.file_path}):`, e.message);
      return res.status(404).json({ message: 'document file missing on storage' });
    }

    const download = req.query.download === '1' || req.query.download === 'true';
    await logAccess({
      userId:     req.user.id,
      documentId: doc.id,
      action:     download ? 'download' : 'view',
      source:     'operator',
      req
    });

    res.setHeader('Content-Type',   doc.file_mime);
    res.setHeader('Content-Length', stat.size);
    res.setHeader('Cache-Control',  'private, no-store');
    res.setHeader('Content-Disposition',
      download
        ? `attachment; filename="fleet-operator-${doc.doc_type}-${doc.id}.${doc.file_path.split('.').pop()}"`
        : 'inline'
    );

    const stream = storage.streamDocument(doc.file_path);
    stream.on('error', (err) => {
      console.warn(`[fleet] stream error for operator doc ${id}:`, err.message);
      if (!res.headersSent) res.status(500);
      res.end();
    });
    stream.pipe(res);
  } catch (err) { next(err); }
});

// ─── GET /expiry-summary  — admin landing dashboard counts ─────────────────
// Counts of CURRENT docs by status across the active fleet plus a list of
// up to 20 documents expiring soonest, for the admin landing page. "Missing"
// is computed as (expected slots − actual current docs): every active
// vehicle expects 3 per-vehicle docs (ownership/insurance/inspection).
// CVOR moved to the operator-level table and is counted separately on
// the dashboard.

router.get('/expiry-summary', requireStaff, async (req, res, next) => {
  try {
    const counts = await queryOne(
      `SELECT
         COUNT(*) FILTER (WHERE d.expiry_date IS NOT NULL AND d.expiry_date < CURRENT_DATE) AS expired,
         COUNT(*) FILTER (WHERE d.expiry_date IS NOT NULL AND d.expiry_date >= CURRENT_DATE AND d.expiry_date <= CURRENT_DATE + INTERVAL '30 days') AS expiring_soon,
         COUNT(*) FILTER (WHERE d.expiry_date IS NULL OR d.expiry_date > CURRENT_DATE + INTERVAL '30 days') AS valid
         FROM fleet_documents d
         JOIN vehicles v ON v.id = d.vehicle_id
        WHERE d.is_current = TRUE AND v.active = TRUE`
    );

    const fleet = await queryOne(
      `SELECT
         COUNT(*) FILTER (WHERE type = 'truck')   AS trucks,
         COUNT(*) FILTER (WHERE type = 'trailer') AS trailers
         FROM vehicles WHERE active = TRUE`
    );

    // Every active vehicle expects 3 per-vehicle docs (ownership, insurance,
    // inspection). CVOR is operator-level and tracked separately.
    const expected = (Number(fleet.trucks) || 0) * 3 + (Number(fleet.trailers) || 0) * 3;
    const actual   = Number(counts.expired) + Number(counts.expiring_soon) + Number(counts.valid);
    const missing  = Math.max(0, expected - actual);

    const attention = await query(
      `SELECT v.id AS vehicle_id, v.unit_number, v.type AS vehicle_type,
              d.id AS document_id, d.doc_type, d.expiry_date,
              CASE
                WHEN d.expiry_date < CURRENT_DATE THEN 'expired'
                WHEN d.expiry_date <= CURRENT_DATE + INTERVAL '30 days' THEN 'expiring_soon'
              END AS status
         FROM fleet_documents d
         JOIN vehicles v ON v.id = d.vehicle_id
        WHERE d.is_current = TRUE
          AND v.active = TRUE
          AND d.expiry_date IS NOT NULL
          AND d.expiry_date <= CURRENT_DATE + INTERVAL '30 days'
        ORDER BY d.expiry_date ASC
        LIMIT 20`
    );

    res.json({
      counts: {
        expired:       Number(counts.expired),
        expiring_soon: Number(counts.expiring_soon),
        valid:         Number(counts.valid),
        missing
      },
      fleet: {
        trucks:   Number(fleet.trucks),
        trailers: Number(fleet.trailers)
      },
      attention
    });
  } catch (err) { next(err); }
});

// ─── GET /access-log  — filterable audit list ──────────────────────────────

router.get('/access-log', requireStaff, async (req, res, next) => {
  try {
    const limit  = Math.min(Math.max(parseInt(req.query.limit, 10)  || 100, 1), 500);
    const offset = Math.max(parseInt(req.query.offset, 10) || 0, 0);

    const where = [];
    const args  = [];
    let i = 1;
    if (req.query.user_id) {
      const uid = parseInt(req.query.user_id, 10);
      if (!Number.isInteger(uid)) return res.status(400).json({ message: 'invalid user_id' });
      where.push(`l.user_id = $${i++}`); args.push(uid);
    }
    if (req.query.vehicle_id) {
      const vid = parseInt(req.query.vehicle_id, 10);
      if (!Number.isInteger(vid)) return res.status(400).json({ message: 'invalid vehicle_id' });
      where.push(`d.vehicle_id = $${i++}`); args.push(vid);
    }
    if (req.query.action) {
      if (!['view', 'download'].includes(req.query.action)) return res.status(400).json({ message: 'invalid action' });
      where.push(`l.action = $${i++}`); args.push(req.query.action);
    }
    if (req.query.since) {
      if (!isISODate(req.query.since)) return res.status(400).json({ message: 'since must be YYYY-MM-DD' });
      where.push(`l.created_at >= $${i++}::date`); args.push(req.query.since);
    }
    if (req.query.until) {
      if (!isISODate(req.query.until)) return res.status(400).json({ message: 'until must be YYYY-MM-DD' });
      where.push(`l.created_at < ($${i++}::date + INTERVAL '1 day')`); args.push(req.query.until);
    }

    args.push(limit, offset);
    // document_id references either fleet_documents (source='vehicle')
    // or fleet_operator_documents (source='operator') — LEFT JOIN both
    // and COALESCE so each log row resolves to whichever table owns it.
    const entries = await query(
      `SELECT l.id, l.action, l.created_at, l.ip_address, l.source,
              e.id AS user_id,
              (e.first_name || ' ' || e.last_name) AS user_name,
              e.email AS user_email,
              COALESCE(d.id, od.id)                AS document_id,
              COALESCE(d.doc_type, od.doc_type)    AS doc_type,
              COALESCE(d.is_current, od.is_current) AS is_current,
              v.id   AS vehicle_id,
              v.unit_number,
              v.type AS vehicle_type
         FROM fleet_document_access_log l
         LEFT JOIN employees                e ON e.id = l.user_id
         LEFT JOIN fleet_documents          d  ON d.id  = l.document_id AND l.source = 'vehicle'
         LEFT JOIN fleet_operator_documents od ON od.id = l.document_id AND l.source = 'operator'
         LEFT JOIN vehicles                 v  ON v.id  = d.vehicle_id
         ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
         ORDER BY l.created_at DESC
         LIMIT $${i++} OFFSET $${i++}`,
      args
    );
    res.json({ entries, limit, offset });
  } catch (err) { next(err); }
});

// ═════════════════════════════════════════════════════════════════════════
// Vehicle finance — purchase / loan / lease details (migration 047)
// ═════════════════════════════════════════════════════════════════════════

// GET /api/fleet/vehicles/:id/finance — finance details for one vehicle.
// Returns a placeholder { acquisition_type: 'owned' } shell when no row
// exists yet so the UI can render the empty form without a 404 dance.
router.get('/vehicles/:id/finance', requireStaff, async (req, res, next) => {
  try {
    const vid = parseInt(req.params.id, 10);
    if (!Number.isInteger(vid)) return res.status(400).json({ message: 'invalid vehicle id' });
    const row = await queryOne(
      `SELECT id, vehicle_id, acquisition_type,
              acquisition_date::text AS acquisition_date,
              lender, account_number,
              purchase_price, down_payment, monthly_payment,
              term_months, interest_rate,
              start_date::text AS start_date,
              end_date::text   AS end_date,
              residual_value, mileage_allowance_km, excess_mileage_charge,
              notes,
              created_at, updated_at
         FROM vehicle_finance
        WHERE vehicle_id = $1`,
      [vid]
    );
    if (!row) {
      return res.json({ vehicle_id: vid, acquisition_type: 'owned', _new: true });
    }
    res.json(row);
  } catch (err) { next(err); }
});

// PUT /api/fleet/vehicles/:id/finance — upsert. Hit it whether the row
// exists or not; we ON CONFLICT on vehicle_id.
router.put('/vehicles/:id/finance', requireStaff, async (req, res, next) => {
  try {
    const vid = parseInt(req.params.id, 10);
    if (!Number.isInteger(vid)) return res.status(400).json({ message: 'invalid vehicle id' });

    const b = req.body || {};
    const acqType = ['owned', 'financed', 'leased'].includes(b.acquisition_type)
      ? b.acquisition_type : 'owned';
    // A lease must carry an end date — the DB CHECK enforces it too, but
    // catching it here gives a friendlier error than the constraint message.
    if (acqType === 'leased' && !b.end_date) {
      return res.status(400).json({ message: 'Lease end date is required for a leased vehicle.' });
    }

    // Helpers — coerce empty strings to NULL so blank inputs don't crash
    // numeric columns.
    const num = (v) => (v === '' || v == null) ? null : Number(v);
    const int = (v) => (v === '' || v == null) ? null : parseInt(v, 10);
    const str = (v) => (v === '' || v == null) ? null : String(v);
    const dat = (v) => (v === '' || v == null) ? null : String(v).slice(0, 10);

    const row = await queryOne(
      `INSERT INTO vehicle_finance
         (vehicle_id, acquisition_type, acquisition_date, lender, account_number,
          purchase_price, down_payment, monthly_payment,
          term_months, interest_rate,
          start_date, end_date,
          residual_value, mileage_allowance_km, excess_mileage_charge,
          notes)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16)
       ON CONFLICT (vehicle_id) DO UPDATE SET
         acquisition_type      = EXCLUDED.acquisition_type,
         acquisition_date      = EXCLUDED.acquisition_date,
         lender                = EXCLUDED.lender,
         account_number        = EXCLUDED.account_number,
         purchase_price        = EXCLUDED.purchase_price,
         down_payment          = EXCLUDED.down_payment,
         monthly_payment       = EXCLUDED.monthly_payment,
         term_months           = EXCLUDED.term_months,
         interest_rate         = EXCLUDED.interest_rate,
         start_date            = EXCLUDED.start_date,
         end_date              = EXCLUDED.end_date,
         residual_value        = EXCLUDED.residual_value,
         mileage_allowance_km  = EXCLUDED.mileage_allowance_km,
         excess_mileage_charge = EXCLUDED.excess_mileage_charge,
         notes                 = EXCLUDED.notes
       RETURNING *`,
      [
        vid, acqType,
        dat(b.acquisition_date), str(b.lender), str(b.account_number),
        num(b.purchase_price), num(b.down_payment), num(b.monthly_payment),
        int(b.term_months), num(b.interest_rate),
        dat(b.start_date), dat(b.end_date),
        num(b.residual_value), int(b.mileage_allowance_km), num(b.excess_mileage_charge),
        str(b.notes),
      ]
    );
    res.json(row);
  } catch (err) { next(err); }
});

// DELETE /api/fleet/vehicles/:id/finance — clear the row (e.g. lease
// paid out, vehicle is now owned outright with no remaining obligations
// to track).
router.delete('/vehicles/:id/finance', requireStaff, async (req, res, next) => {
  try {
    const vid = parseInt(req.params.id, 10);
    if (!Number.isInteger(vid)) return res.status(400).json({ message: 'invalid vehicle id' });
    await query(`DELETE FROM vehicle_finance WHERE vehicle_id = $1`, [vid]);
    res.status(204).end();
  } catch (err) { next(err); }
});

module.exports = router;
