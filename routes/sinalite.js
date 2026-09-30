// routes/sinalite.js
//
// SinaLite wholesale print. Mounted at /api/sinalite.
//   · price lookups for the job page quote sheet (staff)
//   · print-file hosting: staff upload a PDF, SinaLite downloads it from a
//     public tokenized URL when we order
//   · order status webhook from SinaLite (public, secret in the URL)
// Nothing here places an order yet.

'use strict';

const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const express = require('express');
const multer = require('multer');
const { query, queryOne } = require('../db/connection');
const { requireStaff, requireAdmin } = require('../middleware/auth');
const sinalite = require('../suppliers/sinalite/client');
const files = require('../suppliers/sinalite/files');

const router = express.Router();

// Shop address — default ship-to for shipping estimates.
const SHOP_DEST = { zip: 'N0G 2V0', state: 'ON', country: 'CA' };

function productIdOrBail(req, res) {
  const id = parseInt(req.params.id, 10);
  if (!Number.isInteger(id) || id <= 0) {
    res.status(400).json({ message: 'invalid product id' });
    return null;
  }
  return id;
}

function optionIdsOrBail(req, res) {
  const ids = (req.body && req.body.optionIds) || [];
  if (!Array.isArray(ids) || ids.length === 0 || !ids.every((n) => Number.isInteger(Number(n)))) {
    res.status(400).json({ message: 'optionIds must be a non-empty list of option ids' });
    return null;
  }
  return ids.map(Number);
}

function sendError(res, err) {
  console.error('sinalite:', err.message);
  res.status(err.status || 500).json({ message: err.message });
}

// ─── GET /api/sinalite/status ────────────────────────────────────────────
router.get('/status', requireStaff, (req, res) => {
  const cfg = sinalite.loadConfig();
  res.json({ configured: sinalite.isConfigured(cfg), env: cfg.env });
});

// ─── GET /api/sinalite/products ──────────────────────────────────────────
router.get('/products', requireStaff, async (req, res) => {
  try {
    res.json({ products: await sinalite.listProducts(), env: sinalite.loadConfig().env });
  } catch (err) { sendError(res, err); }
});

// ─── GET /api/sinalite/products/:id/options ──────────────────────────────
router.get('/products/:id/options', requireStaff, async (req, res) => {
  const id = productIdOrBail(req, res);
  if (id == null) return;
  try {
    res.json(await sinalite.getProductOptions(id));
  } catch (err) { sendError(res, err); }
});

// ─── POST /api/sinalite/products/:id/price ───────────────────────────────
// Body: { optionIds: [..] } — one option id from each group.
router.post('/products/:id/price', requireStaff, async (req, res) => {
  const id = productIdOrBail(req, res);
  if (id == null) return;
  const optionIds = optionIdsOrBail(req, res);
  if (!optionIds) return;
  try {
    res.json(await sinalite.getPrice(id, optionIds));
  } catch (err) { sendError(res, err); }
});

// ─── POST /api/sinalite/products/:id/shipping ────────────────────────────
// Body: { optionIds: [..], zip?, state?, country? } — defaults to the shop.
router.post('/products/:id/shipping', requireStaff, async (req, res) => {
  const id = productIdOrBail(req, res);
  if (id == null) return;
  const optionIds = optionIdsOrBail(req, res);
  if (!optionIds) return;
  const b = req.body || {};
  const dest = {
    zip: String(b.zip || SHOP_DEST.zip).trim().toUpperCase(),
    state: String(b.state || SHOP_DEST.state).trim().toUpperCase(),
    country: String(b.country || SHOP_DEST.country).trim().toUpperCase(),
  };
  try {
    res.json({ rates: await sinalite.getShippingEstimate(id, optionIds, dest), dest });
  } catch (err) { sendError(res, err); }
});

// ─── Print files ─────────────────────────────────────────────────────────

// Stream uploads straight to the volume (print PDFs can be hundreds of MB),
// then move them into place once they've passed the PDF check.
const upload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => {
      const dir = path.join(files.FILES_DIR, 'tmp');
      fs.mkdir(dir, { recursive: true }, (err) => cb(err, dir));
    },
    filename: (req, file, cb) => cb(null, `${files.newToken()}.upload`),
  }),
  limits: { fileSize: files.MAX_BYTES, files: 1 },
});

function fileRow(r) {
  return {
    token: r.token,
    project_id: r.project_id,
    original_name: r.original_name,
    size_bytes: Number(r.size_bytes),
    created_at: r.created_at,
    url: files.publicUrl(r.token, r.original_name),
  };
}

// ─── POST /api/sinalite/files ────────────────────────────────────────────
// multipart: file (PDF), project_id (optional). Returns { url, ... }.
router.post('/files', requireStaff, (req, res) => {
  upload.single('file')(req, res, async (err) => {
    const tmp = req.file && req.file.path;
    const cleanup = () => tmp && fsp.unlink(tmp).catch(() => {});
    if (err) {
      cleanup();
      const tooBig = err.code === 'LIMIT_FILE_SIZE';
      return res.status(tooBig ? 413 : 400).json({
        message: tooBig ? `File too large — max ${files.MAX_BYTES / 1024 / 1024} MB` : err.message,
      });
    }
    if (!req.file) return res.status(400).json({ message: 'file is required' });
    try {
      const fh = await fsp.open(tmp, 'r');
      const head = Buffer.alloc(1024);
      await fh.read(head, 0, 1024, 0);
      await fh.close();
      if (!files.looksLikePdf(head)) {
        cleanup();
        return res.status(400).json({ message: `${req.file.originalname} is not a PDF — SinaLite only accepts PDF files` });
      }
      const projectId = parseInt(req.body.project_id, 10);
      const token = files.newToken();
      const rel = await files.storeUpload(tmp, token);
      const row = await queryOne(
        `INSERT INTO sinalite_files (token, project_id, original_name, file_path, size_bytes, uploaded_by)
         VALUES ($1, $2, $3, $4, $5, $6)
         RETURNING token, project_id, original_name, size_bytes, created_at`,
        [token, Number.isInteger(projectId) && projectId > 0 ? projectId : null,
         req.file.originalname, rel, req.file.size, req.user.id || null]
      );
      res.status(201).json(fileRow(row));
    } catch (e) {
      cleanup();
      sendError(res, e);
    }
  });
});

// ─── GET /api/sinalite/files?project_id= ─────────────────────────────────
router.get('/files', requireStaff, async (req, res) => {
  try {
    const projectId = parseInt(req.query.project_id, 10);
    const rows = await query(
      `SELECT token, project_id, original_name, size_bytes, created_at
         FROM sinalite_files
        WHERE deleted_at IS NULL
          AND ($1::int IS NULL OR project_id = $1)
        ORDER BY created_at DESC
        LIMIT 200`,
      [Number.isInteger(projectId) ? projectId : null]
    );
    res.json({ files: rows.map(fileRow) });
  } catch (e) { sendError(res, e); }
});

// ─── GET /api/sinalite/files/:token/:name ────────────────────────────────
// PUBLIC — this is the URL SinaLite downloads from. The token is the auth;
// the name is only there so the file has a sensible name on their end.
router.get('/files/:token/:name?', async (req, res) => {
  const token = String(req.params.token || '').toLowerCase();
  if (!files.TOKEN_RE.test(token)) return res.status(404).end();
  try {
    const row = await queryOne(
      `SELECT file_path, original_name, size_bytes FROM sinalite_files
        WHERE token = $1 AND deleted_at IS NULL`,
      [token]
    );
    if (!row) return res.status(404).end();
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `inline; filename="${files.safeName(row.original_name)}"`);
    res.setHeader('X-Robots-Tag', 'noindex');
    res.sendFile(files.absPath(row.file_path), (err) => {
      if (err && !res.headersSent) res.status(404).end();
    });
  } catch (e) { sendError(res, e); }
});

// ─── GET /api/sinalite/setup ─────────────────────────────────────────────
// The two URLs SinaLite needs (file host + webhook). Admin only because
// the webhook URL contains its secret.
router.get('/setup', requireAdmin, (req, res) => {
  res.json({
    env: sinalite.loadConfig().env,
    fileHost: files.PUBLIC_BASE,
    webhookUrl: files.webhookUrl(),
  });
});

// ─── Order status webhook ────────────────────────────────────────────────

// ─── POST /api/sinalite/webhook/:secret ──────────────────────────────────
// PUBLIC — SinaLite posts order status here, e.g.
//   { order_id, status: "SHIPPED", timestamp, items: [...], shipping: "<tracking>" }
// Stored as-is; wiring events to jobs comes with ordering.
router.post('/webhook/:secret', async (req, res) => {
  if (!files.secretMatches(req.params.secret)) return res.status(404).end();
  const b = req.body && typeof req.body === 'object' ? req.body : {};
  try {
    await query(
      `INSERT INTO sinalite_webhook_events (order_id, status, tracking, payload)
       VALUES ($1, $2, $3, $4)`,
      [
        b.order_id != null ? String(b.order_id) : null,
        b.status ? String(b.status) : null,
        b.shipping ? String(b.shipping) : null,
        JSON.stringify(b),
      ]
    );
    res.json({ ok: true });
  } catch (e) { sendError(res, e); }
});

// ─── GET /api/sinalite/webhook-events ────────────────────────────────────
router.get('/webhook-events', requireStaff, async (req, res) => {
  try {
    const rows = await query(
      `SELECT id, received_at, order_id, status, tracking, payload
         FROM sinalite_webhook_events
        ORDER BY received_at DESC
        LIMIT 100`
    );
    res.json({ events: rows });
  } catch (e) { sendError(res, e); }
});

module.exports = router;
