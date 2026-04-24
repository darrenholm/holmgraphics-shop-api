// routes/designs.js
// Customer artwork upload for the DTF online store.
//
// After POST /api/orders creates the order (status='awaiting_artwork'),
// the frontend uploads each design via POST /api/designs/:id/upload
// (multipart). This route:
//
//   1. Verifies the design belongs to the calling customer.
//   2. Resolves the client name + job number from the order.
//   3. Streams the file to files-bridge → L:\...\Job<num>\designs\<uuid>.<ext>
//   4. Updates the design row with the saved path.
//   5. If all designs for the order now have artwork, advances the order
//      from 'awaiting_artwork' to 'awaiting_proof' and creates a Sales
//      Receipt in QBO (via the queueSync helper).
//
// File limits enforced by multer:
//   - max 50 MB
//   - one file per request
// Allowed types: PNG / JPG / PDF / SVG / AI / PSD / TIFF / WebP

'use strict';

const express = require('express');
const multer  = require('multer');
const path    = require('path');
const { query, queryOne } = require('../db/connection');
const { requireCustomer } = require('../middleware/customer-auth');
const filesBridge = require('../lib/files-bridge-client');

const router = express.Router();

const UPLOAD_MAX_BYTES = 50 * 1024 * 1024;
const ALLOWED_MIMES = new Set([
  'image/png', 'image/jpeg', 'image/jpg', 'image/webp',
  'image/svg+xml', 'image/tiff',
  'application/pdf',
  'application/illustrator', 'application/postscript',
  'image/vnd.adobe.photoshop', 'application/x-photoshop',
  'application/octet-stream',  // many browsers send AI/PSD as this
]);
const ALLOWED_EXTS = new Set(['.png','.jpg','.jpeg','.gif','.webp','.svg','.tif','.tiff','.pdf','.ai','.eps','.psd']);

const upload = multer({
  storage: multer.memoryStorage(),
  limits:  { fileSize: UPLOAD_MAX_BYTES, files: 1 },
});

// Resolve a client's "files folder name" the way the bridge expects.
// Match the convention in lookupRoutes / quickbooks.js: prefer the override
// (clients.files_folder), else company, else "lname fname".
function resolveClientNameForBridge(c) {
  if (c.files_folder) return c.files_folder;
  if (c.company)      return c.company;
  const parts = [c.fname, c.lname].filter(Boolean);
  if (parts.length) return parts.join(' ');
  return `Client${c.id}`;
}

// POST /api/designs/:id/upload   (multipart with `file`)
router.post('/:id/upload', requireCustomer, upload.single('file'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'file field required (multipart/form-data)' });
    const ext = path.extname(req.file.originalname || '').toLowerCase();
    if (!ALLOWED_EXTS.has(ext)) {
      return res.status(415).json({ error: `Unsupported file extension: ${ext || '(none)'}. Use PNG, JPG, PDF, SVG, AI, EPS, or PSD.` });
    }
    if (!ALLOWED_MIMES.has(req.file.mimetype) && !req.file.mimetype.startsWith('image/')) {
      // Don't be too strict — many Adobe formats come with weird mimes.
      console.warn(`Unusual mime type for ${req.file.originalname}: ${req.file.mimetype}`);
    }

    const designId = req.params.id;

    // Look up the design + its order + the customer to verify ownership.
    const row = await queryOne(
      `SELECT d.id            AS design_id,
              d.order_id,
              d.name          AS design_name,
              o.order_number,
              o.client_id,
              o.job_id,
              o.status        AS order_status,
              c.id            AS client_id,
              c.fname, c.lname, c.company, c.files_folder
         FROM designs d
         JOIN orders  o ON o.id = d.order_id
         JOIN clients c ON c.id = o.client_id
        WHERE d.id = $1
          AND o.client_id = $2
        LIMIT 1`,
      [designId, req.customer.id]
    );
    if (!row) return res.status(404).json({ error: 'Design not found or access denied' });
    if (row.order_status !== 'awaiting_artwork') {
      return res.status(409).json({
        error: `Cannot upload artwork — order status is "${row.order_status}". Artwork can only be uploaded while the order is awaiting artwork.`,
      });
    }

    const clientName = resolveClientNameForBridge(row);
    const safeFilename = `${designId}${ext}`;   // canonical: <design-uuid>.<ext>

    // Push to files-bridge. This also auto-creates the client + job folders
    // if they don't exist yet (POST /upload calls /ensure semantics).
    const saved = await filesBridge.uploadFile({
      clientName,
      jobNo:     row.job_id,
      subfolder: 'designs',
      fileName:  safeFilename,
      fileBuffer: req.file.buffer,
      mimeType:  req.file.mimetype,
    });

    // Update the design row.
    await query(
      `UPDATE designs SET
         artwork_path        = $1,
         artwork_filename    = $2,
         artwork_mime        = $3,
         artwork_size_bytes  = $4
       WHERE id = $5`,
      [saved.path, safeFilename, req.file.mimetype, req.file.size, designId]
    );

    // If every design on this order now has artwork, advance the order.
    const pending = await queryOne(
      `SELECT COUNT(*)::int AS pending
         FROM designs
        WHERE order_id = $1
          AND (artwork_path IS NULL OR artwork_path = '(pending upload)')`,
      [row.order_id]
    );
    let orderAdvanced = false;
    if (pending.pending === 0) {
      await query(
        `UPDATE orders SET status = 'awaiting_proof' WHERE id = $1 AND status = 'awaiting_artwork'`,
        [row.order_id]
      );
      orderAdvanced = true;
      // TODO: enqueue QBO Sales Receipt creation. For now we log so an
      // admin can manually trigger from the order detail page.
      console.log(`[designs] order ${row.order_number} advanced to awaiting_proof — QBO sync TODO`);
    }

    res.json({
      ok:              true,
      design_id:       designId,
      filename:        safeFilename,
      saved_path:      saved.path,
      size_bytes:      req.file.size,
      mime:            req.file.mimetype,
      order_advanced:  orderAdvanced,
      next_step:       orderAdvanced
        ? 'Awaiting proof from our design team. We\'ll email you a proof to approve before we print.'
        : 'Upload remaining designs.',
    });
  } catch (err) {
    console.error('design upload failed:', err);
    res.status(500).json({ error: 'Upload failed', detail: err.message });
  }
});

// GET /api/designs/:id  — metadata only
router.get('/:id', requireCustomer, async (req, res) => {
  try {
    const row = await queryOne(
      `SELECT d.* FROM designs d
         JOIN orders o ON o.id = d.order_id
        WHERE d.id = $1 AND o.client_id = $2`,
      [req.params.id, req.customer.id]
    );
    if (!row) return res.status(404).json({ error: 'Not found' });
    res.json({ design: row });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Multer-specific error handler — clean 413 instead of 500 for too-large.
router.use((err, req, res, next) => {
  if (err instanceof multer.MulterError) {
    if (err.code === 'LIMIT_FILE_SIZE') {
      return res.status(413).json({ error: `File too large. Maximum is ${UPLOAD_MAX_BYTES / 1024 / 1024} MB.` });
    }
    return res.status(400).json({ error: `Upload error: ${err.message}` });
  }
  next(err);
});

module.exports = router;
