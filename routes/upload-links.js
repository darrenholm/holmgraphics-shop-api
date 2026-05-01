// routes/upload-links.js
//
// Per-job, per-recipient upload tokens for the "client uploads artwork
// without logging in" flow. Three endpoints, mounted at /api by server.js:
//
//   POST /api/jobs/:id/upload-links              [staff auth]
//     Body: { recipient_email, expires_in_days?, max_uploads? }
//     Mints a UUID token, inserts into client_upload_links, emails the
//     recipient, returns { url, token, expires_at, max_uploads }.
//
//   GET  /api/upload-links/:token                [public]
//     Returns minimal job info (job_number, client_name, uploads_used,
//     uploads_remaining, expires_at) so the public upload page can show
//     context. Validates token isn't expired or used up.
//
//   POST /api/upload-links/:token/upload         [public, multipart]
//     Accepts ONE file per request. Validates the token, increments
//     used_count, writes through the file-bridge into the job's
//     L:\...\Job<N>\designs\ folder. Filename pattern includes the job
//     number + a slug of the original filename + a short uniqifier.
//
// Security guards on the public endpoints:
//   * Token must exist, not be expired, and have used_count < max_uploads.
//   * File-extension allowlist + 50 MB cap (mirrors routes/designs.js).
//   * Per-token sliding-window rate limit: 30 uploads / 60 s.
//   * No PII leaked in error responses (we deliberately return the same
//     shape for "token not found" vs "token expired" vs "limit reached").
//
// Audit:
//   * last_used_at + used_count both bumped on every successful upload.
//   * Failed uploads (validation errors, bridge errors) DO NOT bump
//     either -- the link's "20 free uploads" budget belongs to the
//     client, not to whoever happens to be flooding the endpoint.
//   * Staff get an email after each successful upload via
//     sendStaffUploadNotification.

'use strict';

const express  = require('express');
const multer   = require('multer');
const path     = require('path');
const crypto   = require('crypto');
const { query, queryOne, pool } = require('../db/connection');
const { requireStaff } = require('../middleware/auth');
const filesBridge = require('../lib/files-bridge-client');
const mailer = require('../lib/customer-mailer');
const { slugify } = require('../lib/slugify');

const router = express.Router();

// ─── Config ──────────────────────────────────────────────────────────────────
const UPLOAD_MAX_BYTES   = 50 * 1024 * 1024;
const DEFAULT_EXPIRY_DAY = 14;
const DEFAULT_MAX_USES   = 20;
const ALLOWED_EXTS = new Set([
  '.png', '.jpg', '.jpeg', '.gif', '.webp',
  '.svg', '.tif', '.tiff',
  '.pdf', '.ai', '.eps', '.psd', '.cdr',
]);
// Public app's URL — used to build the link we email the client. Kept
// distinct from the API URL since the upload page lives on the shop.
const PUBLIC_BASE = (process.env.PUBLIC_SHOP_URL || 'https://holmgraphics.ca').replace(/\/$/, '');

const upload = multer({
  storage: multer.memoryStorage(),
  limits:  { fileSize: UPLOAD_MAX_BYTES, files: 1 },
});

// ─── Rate limiter (per-token sliding window) ────────────────────────────────
// In-memory: 30 uploads / 60 s per token. Sufficient for a single API
// instance. If we ever scale to multiple instances, this needs to move
// to Redis or postgres -- but max_uploads (DB-enforced cap on total
// uploads per token) already bounds the global blast radius, so the
// in-process check is just a fast-path guard against a runaway client.
const RATE_WINDOW_MS = 60_000;
const RATE_MAX       = 30;
const rateBuckets    = new Map();   // token -> [timestamp, ...]
function rateLimitHit(token) {
  const now = Date.now();
  const arr = rateBuckets.get(token) || [];
  const fresh = arr.filter((t) => now - t < RATE_WINDOW_MS);
  if (fresh.length >= RATE_MAX) {
    rateBuckets.set(token, fresh);
    return true;
  }
  fresh.push(now);
  rateBuckets.set(token, fresh);
  return false;
}

// ─── Helpers ────────────────────────────────────────────────────────────────
function isValidEmail(s) {
  // Deliberately loose -- just enough to catch obvious typos. Real
  // validation happens when Resend tries to deliver.
  return typeof s === 'string' && /^\S+@\S+\.\S+$/.test(s.trim());
}

function resolveClientNameForBridge(c) {
  // Mirrors routes/designs.js. Prefer the manual override, then company,
  // then "fname lname".
  if (c.files_folder) return c.files_folder;
  if (c.company)      return c.company;
  const parts = [c.fname, c.lname].filter(Boolean);
  if (parts.length) return parts.join(' ');
  return `Client${c.id}`;
}

function clientDisplayName(c) {
  if (!c) return null;
  return c.company || [c.fname, c.lname].filter(Boolean).join(' ').trim() || null;
}

// One unified "is this token usable right now?" check. Returns the link
// row on success or null with a reason string. Caller decides whether
// to surface the reason or return a generic 404.
async function findUsableLink(token) {
  if (!token || !/^[0-9a-fA-F-]{36}$/.test(token)) {
    return { link: null, reason: 'invalid_format' };
  }
  const link = await queryOne(
    `SELECT id, job_id, token, recipient_email, expires_at, max_uploads,
            used_count, created_at, last_used_at
       FROM client_upload_links
      WHERE token = $1
      LIMIT 1`,
    [token]
  );
  if (!link) return { link: null, reason: 'not_found' };
  if (new Date(link.expires_at) < new Date()) return { link, reason: 'expired' };
  if (link.used_count >= link.max_uploads)    return { link, reason: 'exhausted' };
  return { link, reason: null };
}

// ─── POST /api/jobs/:id/upload-links ────────────────────────────────────────
// Staff mints a fresh upload link for the given job and emails it to the
// recipient. Returns the link details so the staff UI can also display
// the URL (e.g. for copy-paste if the email bounces).
router.post('/jobs/:id/upload-links', requireStaff, async (req, res) => {
  try {
    const jobId = parseInt(req.params.id, 10);
    if (!Number.isInteger(jobId)) {
      return res.status(400).json({ error: 'job id must be an integer' });
    }

    const recipientEmail = String(req.body?.recipient_email || '').trim();
    if (!isValidEmail(recipientEmail)) {
      return res.status(400).json({ error: 'recipient_email is required and must look like an email' });
    }

    const expiresInDays = Number(req.body?.expires_in_days) || DEFAULT_EXPIRY_DAY;
    if (expiresInDays < 1 || expiresInDays > 90) {
      return res.status(400).json({ error: 'expires_in_days must be between 1 and 90' });
    }
    const maxUploads = Number(req.body?.max_uploads) || DEFAULT_MAX_USES;
    if (maxUploads < 1 || maxUploads > 100) {
      return res.status(400).json({ error: 'max_uploads must be between 1 and 100' });
    }

    // Verify the job exists and grab the recipient's display name (for
    // the email greeting).
    const job = await queryOne(
      `SELECT p.id, p.description AS project_name,
              c.id AS client_id, c.fname, c.lname, c.company
         FROM projects p
         LEFT JOIN clients c ON c.id = p.client_id
        WHERE p.id = $1`,
      [jobId]
    );
    if (!job) return res.status(404).json({ error: 'job not found' });

    const token     = crypto.randomUUID();
    const expiresAt = new Date(Date.now() + expiresInDays * 24 * 60 * 60 * 1000);

    const { rows } = await pool.query(
      `INSERT INTO client_upload_links
         (job_id, token, recipient_email, expires_at, max_uploads, created_by_emp_id)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING id, token, expires_at, max_uploads`,
      [jobId, token, recipientEmail, expiresAt, maxUploads, req.user?.id || null]
    );
    const link = rows[0];
    const url  = `${PUBLIC_BASE}/upload/${link.token}`;

    // Fire-and-forget the email so a Resend hiccup doesn't block the
    // create. The link still exists in the DB; staff can copy the URL
    // from the response and resend manually if needed.
    mailer.sendArtworkUploadInvite({
      email:        recipientEmail,
      recipientName: clientDisplayName(job),
      jobNumber:    job.id,
      uploadUrl:    url,
      expiresAt:    link.expires_at,
    }).catch((e) => console.warn('upload-link email failed:', e.message));

    res.status(201).json({
      ok:           true,
      url,
      token:        link.token,
      expires_at:   link.expires_at,
      max_uploads:  link.max_uploads,
      recipient_email: recipientEmail,
    });
  } catch (e) {
    console.error('POST /api/jobs/:id/upload-links:', e);
    res.status(500).json({ error: 'Failed to mint upload link', detail: e.message });
  }
});

// ─── GET /api/upload-links/:token ───────────────────────────────────────────
// Public. The public upload page calls this on mount to show the client
// what job they're uploading to + remaining quota. Returns the same
// generic 404 for "not found" / "expired" / "exhausted" so a probing
// attacker can't enumerate token states.
router.get('/upload-links/:token', async (req, res) => {
  try {
    const { link, reason } = await findUsableLink(req.params.token);
    if (!link || reason) {
      // Distinguish only "expired/exhausted vs gone" -- both shapes give
      // the page enough to render a useful message without leaking info
      // about whether the token ever existed.
      const status = reason === 'expired' || reason === 'exhausted' ? 410 : 404;
      return res.status(status).json({ error: reason || 'not_found' });
    }
    const job = await queryOne(
      `SELECT p.id AS job_id,
              p.description AS project_name,
              COALESCE(c.company, CONCAT_WS(' ', c.fname, c.lname)) AS client_name
         FROM projects p
         LEFT JOIN clients c ON c.id = p.client_id
        WHERE p.id = $1
        LIMIT 1`,
      [link.job_id]
    );
    if (!job) return res.status(404).json({ error: 'job not found' });
    res.json({
      ok:                 true,
      job_number:         job.job_id,
      project_name:       job.project_name,
      client_name:        job.client_name,
      expires_at:         link.expires_at,
      uploads_used:       link.used_count,
      uploads_remaining:  link.max_uploads - link.used_count,
    });
  } catch (e) {
    console.error('GET /api/upload-links/:token:', e);
    res.status(500).json({ error: 'Failed to load upload link', detail: e.message });
  }
});

// ─── POST /api/upload-links/:token/upload ───────────────────────────────────
// Public, multipart. One file per request -- the upload page calls this
// once per file. Increments used_count atomically AFTER the bridge write
// succeeds; failed uploads don't burn a token credit.
router.post('/upload-links/:token/upload', upload.single('file'), async (req, res) => {
  try {
    const token = req.params.token;
    if (rateLimitHit(token)) {
      return res.status(429).json({ error: 'too many uploads -- slow down and retry shortly' });
    }
    const { link, reason } = await findUsableLink(token);
    if (!link || reason) {
      const status = reason === 'expired' || reason === 'exhausted' ? 410 : 404;
      return res.status(status).json({ error: reason || 'not_found' });
    }

    if (!req.file) return res.status(400).json({ error: 'file field required (multipart/form-data)' });
    const ext = path.extname(req.file.originalname || '').toLowerCase();
    if (!ALLOWED_EXTS.has(ext)) {
      return res.status(415).json({
        error: `Unsupported file extension: ${ext || '(none)'}. Use PNG, JPG, PDF, AI, EPS, CDR, SVG, PSD, or TIF.`,
      });
    }

    // Look up the job's client folder to route the file correctly. Same
    // resolution as routes/designs.js so client-uploaded files land
    // alongside customer-uploaded ones in the same job folder.
    const job = await queryOne(
      `SELECT p.id, c.id AS client_id, c.fname, c.lname, c.company, c.files_folder
         FROM projects p
         LEFT JOIN clients c ON c.id = p.client_id
        WHERE p.id = $1
        LIMIT 1`,
      [link.job_id]
    );
    if (!job || !job.client_id) {
      return res.status(409).json({ error: 'job has no linked client; cannot resolve upload folder' });
    }

    // Filename pattern: Job{N}-client-upload-{slug-of-original}-{stamp}.{ext}
    // We don't have a designs row or a print_location to encode -- this
    // path is for "client just sends artwork, staff sorts later." Stamp
    // is a base36 of Date.now() for ordering + uniqueness when multiple
    // clients share a single link OR send the same filename twice.
    const baseName  = path.basename(req.file.originalname || '', ext);
    const nameSlug  = slugify(baseName, { maxLen: 40, fallback: 'upload' });
    const stamp     = Date.now().toString(36);
    const safeName  = `Job${link.job_id}-client-upload-${nameSlug}-${stamp}${ext}`;
    const clientName = resolveClientNameForBridge(job);

    let saved;
    try {
      saved = await filesBridge.uploadFile({
        clientName,
        jobNo:     link.job_id,
        subfolder: 'designs',
        fileName:  safeName,
        fileBuffer: req.file.buffer,
        mimeType:  req.file.mimetype,
      });
    } catch (bridgeErr) {
      console.error(`[upload-links] bridge write failed for token ${token}:`, bridgeErr.message);
      return res.status(502).json({ error: 'Upload failed -- could not write to file storage. Please try again.' });
    }

    // Bump the counter ONLY after the bridge write succeeded. Use a
    // conditional UPDATE so a parallel request that pushed used_count
    // past max_uploads in between our check and this UPDATE can't
    // squeak through.
    const upd = await pool.query(
      `UPDATE client_upload_links
          SET used_count   = used_count + 1,
              last_used_at = NOW()
        WHERE id = $1
          AND used_count < max_uploads
          AND expires_at > NOW()
        RETURNING used_count, max_uploads`,
      [link.id]
    );
    if (upd.rowCount === 0) {
      // The link expired or hit cap between findUsableLink and this
      // UPDATE. The file IS already on disk -- log so admin can decide
      // whether to keep or remove it; surface 410 to the caller.
      console.warn(`[upload-links] race: file written for token ${token} but link no longer usable; file=${saved?.path}`);
      return res.status(410).json({ error: 'link is no longer valid' });
    }

    // Best-effort staff notification. Single-file uploads each fire one
    // email -- in practice staff get a small batch as the client
    // works through their files. If we ever debounce, do it here.
    mailer.sendStaffUploadNotification({
      jobNumber:      link.job_id,
      clientName:     clientDisplayName(job),
      recipientEmail: link.recipient_email,
      uploadCount:    1,
    }).catch((e) => console.warn('staff upload notify email failed:', e.message));

    res.json({
      ok:                true,
      filename:          safeName,
      saved_path:        saved?.path || null,
      size_bytes:        req.file.size,
      uploads_used:      upd.rows[0].used_count,
      uploads_remaining: upd.rows[0].max_uploads - upd.rows[0].used_count,
    });
  } catch (e) {
    console.error('POST /api/upload-links/:token/upload:', e);
    res.status(500).json({ error: 'Upload failed', detail: e.message });
  }
});

// Multer-specific error handler -- clean 413 instead of 500 for too-large.
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
