// routes/project-proofs.js
// Per-project proof approval system. Staff uploads a JPEG (or PNG/PDF),
// the customer gets a tokenized URL, views the proof in their browser,
// optionally annotates it, then approves or requests changes. Everything
// posts back to project_messages so the thread stays unified.
//
// Storage: WHC web host (same as job photos) so the JPEG has a public
// URL — required for the customer's browser to render it and for the
// annotation canvas to overlay on it.
//
// Status transitions on the proof row:
//   sent → viewed (first GET by-token)
//        → approved (POST /approve) — optionally bumps project.status_id
//        → changes_requested (POST /request-changes) — staff prepares
//          next version, which marks this one 'superseded'.

'use strict';

const express = require('express');
const multer  = require('multer');
const crypto  = require('crypto');
const path    = require('path');
const ftp     = require('basic-ftp');
const { Readable } = require('stream');
const { query, queryOne } = require('../db/connection');
const { requireStaff } = require('../middleware/auth');
const mailer = require('../lib/customer-mailer');

const router = express.Router();

// ─── WHC FTP config (mirrors routes/projects.js) ─────────────────────────────
const WHC_HOST        = process.env.WHC_FTP_HOST;
const WHC_PORT        = parseInt(process.env.WHC_FTP_PORT || '21', 10);
const WHC_USER        = process.env.WHC_FTP_USER;
const WHC_PASS        = process.env.WHC_FTP_PASSWORD;
const WHC_SECURE      = process.env.WHC_FTP_SECURE !== 'false';
const WHC_REMOTE_BASE = (process.env.WHC_REMOTE_BASE || 'public_html/shop-uploads/jobs').replace(/\/$/, '');
const WHC_PUBLIC_BASE = (process.env.WHC_PUBLIC_BASE || 'https://holmgraphics.ca/shop-uploads/jobs').replace(/\/$/, '');
const PUBLIC_SHOP_URL = (process.env.PUBLIC_SHOP_URL || 'https://shop.holmgraphics.ca').replace(/\/$/, '');

function whcConfigured() {
  return Boolean(WHC_HOST && WHC_USER && WHC_PASS);
}

async function connectFtp(timeoutMs = 30000) {
  if (!whcConfigured()) throw new Error('WHC FTP env vars not configured');
  const client = new ftp.Client(timeoutMs);
  client.ftp.verbose = false;
  await client.access({
    host: WHC_HOST, port: WHC_PORT, user: WHC_USER, password: WHC_PASS,
    secure: WHC_SECURE,
    secureOptions: WHC_SECURE ? { checkServerIdentity: () => undefined } : undefined,
  });
  return client;
}

// 50 MB cap — proofs are usually 1-5 MB JPEGs but allow PDFs and high-res
// images. Memory storage (Railway has no persistent fs).
const upload = multer({
  storage: multer.memoryStorage(),
  limits:  { fileSize: 50 * 1024 * 1024, files: 1 },
  fileFilter: (req, file, cb) => {
    const ok = /^(image\/(jpeg|jpg|png|webp)|application\/pdf)$/i.test(file.mimetype || '');
    if (!ok) return cb(new Error(`unsupported file type: ${file.mimetype}`));
    cb(null, true);
  },
});

function genToken() {
  return crypto.randomBytes(32).toString('base64url');
}

function proofPublicUrl(projectId, filename) {
  return `${WHC_PUBLIC_BASE}/${projectId}/proofs/${encodeURIComponent(filename)}`;
}

// ─── POST /api/projects/:id/proofs ───────────────────────────────────────────
// Multipart: file (required), approve_status_id (optional int), note (optional)
// Uploads to WHC, inserts a project_proofs row, emails the customer.
router.post('/projects/:id/proofs', requireStaff, (req, res, next) => {
  upload.single('file')(req, res, (err) => {
    if (err) {
      if (err.code === 'LIMIT_FILE_SIZE') return res.status(413).json({ message: 'File too large (max 50 MB)' });
      return res.status(400).json({ message: err.message });
    }
    handleProofUpload(req, res).catch(next);
  });
});

async function handleProofUpload(req, res) {
  const projectId = parseInt(req.params.id, 10);
  if (!Number.isInteger(projectId)) return res.status(400).json({ message: 'invalid project id' });
  if (!req.file) return res.status(400).json({ message: 'file field required' });

  const approveStatusId = req.body.approve_status_id ? parseInt(req.body.approve_status_id, 10) : null;
  const note = (req.body.note || '').toString().trim() || null;
  // Optional per-proof recipient override — useful when staff want to send
  // a proof to a different contact (e.g. designer's personal email) without
  // changing the job's contact_email permanently. Validated below.
  const recipientOverride = (req.body.recipient_email || '').toString().trim() || null;

  // Look up project + customer details for the email.
  const proj = await queryOne(
    `SELECT p.id, p.description AS project_name,
            p.contact_email, p.contact_name,
            c.email AS client_email,
            COALESCE(c.company, CONCAT_WS(' ', c.fname, c.lname)) AS client_name,
            e.email AS assigned_email,
            TRIM(CONCAT_WS(' ', e.first_name, e.last_name)) AS assigned_name
       FROM projects p
       LEFT JOIN clients   c ON c.id = p.client_id
       LEFT JOIN employees e ON e.id = p.production_emp_id
      WHERE p.id = $1`,
    [projectId]
  );
  if (!proj) return res.status(404).json({ message: 'project not found' });

  // Recipient priority: explicit override > project contact > client default.
  // Validate the override so we don't try to send mail to "bob" or "".
  let customerEmail = null;
  if (recipientOverride) {
    if (!/^\S+@\S+\.\S+$/.test(recipientOverride)) {
      return res.status(400).json({ message: 'Invalid recipient_email.' });
    }
    customerEmail = recipientOverride;
  } else {
    customerEmail = (proj.contact_email && proj.contact_email.trim())
      || (proj.client_email && proj.client_email.trim())
      || null;
  }
  if (!customerEmail) {
    return res.status(400).json({ message: 'No customer email on file — set contact_email on the job first.' });
  }

  // Next version number.
  const last = await queryOne(
    `SELECT COALESCE(MAX(version), 0) AS v FROM project_proofs WHERE project_id = $1`,
    [projectId]
  );
  const version = Number(last.v) + 1;

  // Generate token + filename.
  const token = genToken();
  const ext = path.extname(req.file.originalname || '').toLowerCase() || (
    req.file.mimetype === 'application/pdf' ? '.pdf' :
    req.file.mimetype === 'image/png'       ? '.png' :
    req.file.mimetype === 'image/webp'      ? '.webp' :
    '.jpg'
  );
  // Filename includes token so the file URL is unguessable even though
  // WHC serves the directory publicly.
  const safeFileName = `v${version}-${token.slice(0, 16)}${ext}`;
  const remoteDir = `${WHC_REMOTE_BASE}/${projectId}/proofs`;

  // Upload to WHC.
  let ftpClient;
  try {
    ftpClient = await connectFtp();
    await ftpClient.ensureDir(remoteDir);
    await ftpClient.uploadFrom(Readable.from(req.file.buffer), safeFileName);
  } catch (e) {
    console.error('[project-proofs] WHC upload failed:', e);
    if (ftpClient) ftpClient.close();
    return res.status(500).json({ message: 'Failed to upload proof file', detail: e.message });
  } finally {
    if (ftpClient) ftpClient.close();
  }

  // Mark any previous proof as superseded (so the customer doesn't get
  // confused about which one is current).
  await query(
    `UPDATE project_proofs
        SET status = 'superseded'
      WHERE project_id = $1 AND status IN ('sent', 'viewed', 'changes_requested')`,
    [projectId]
  );

  // Insert the new proof row.
  const row = await queryOne(
    `INSERT INTO project_proofs
       (project_id, version, file_path, file_mime, file_size_bytes,
        token, status, approve_status_id, uploaded_by, sent_to_email)
     VALUES ($1, $2, $3, $4, $5, $6, 'sent', $7, $8, $9)
     RETURNING id, project_id, version, status, token, uploaded_at`,
    [
      projectId, version, safeFileName, req.file.mimetype,
      req.file.buffer.length, token,
      Number.isInteger(approveStatusId) ? approveStatusId : null,
      req.user?.id || null, customerEmail,
    ]
  );

  // Also post into project_messages so the thread shows the proof was sent.
  const authorName = [req.user?.first_name, req.user?.last_name].filter(Boolean).join(' ').trim()
    || req.user?.email || 'Holm Graphics';
  await query(
    `INSERT INTO project_messages (project_id, author_type, author_id, author_name, body)
     VALUES ($1, 'staff', $2, $3, $4)`,
    [
      projectId, req.user?.id || null, authorName,
      `📎 Sent proof v${version} for review${note ? ` — ${note}` : ''}.`,
    ]
  );

  const approvalUrl = `${PUBLIC_SHOP_URL}/proofs/${token}`;
  const imageUrl = proofPublicUrl(projectId, safeFileName);

  // Send the email. Best-effort — proof row exists either way.
  mailer.sendProjectProofRequest({
    recipientEmail: customerEmail,
    projectId, projectName: proj.project_name,
    version, approvalUrl, imageUrl,
    senderName: authorName, note,
  }).catch((e) => console.warn('[project-proofs] customer email failed:', e.message));

  res.status(201).json({
    id: row.id, project_id: row.project_id, version: row.version,
    status: row.status, token: row.token, uploaded_at: row.uploaded_at,
    image_url: imageUrl, approval_url: approvalUrl,
  });
}

// ─── GET /api/projects/:id/proofs ────────────────────────────────────────────
// List all versions for a project (staff). Newest first.
router.get('/projects/:id/proofs', requireStaff, async (req, res, next) => {
  try {
    const projectId = parseInt(req.params.id, 10);
    if (!Number.isInteger(projectId)) return res.status(400).json({ message: 'invalid project id' });
    const rows = await query(
      `SELECT p.id, p.project_id, p.version, p.file_path, p.file_mime,
              p.token, p.status, p.approve_status_id,
              p.uploaded_at, p.sent_to_email, p.first_viewed_at, p.responded_at,
              p.response_name, p.response_text, p.annotations,
              p.uploaded_by,
              TRIM(CONCAT_WS(' ', e.first_name, e.last_name)) AS uploaded_by_name
         FROM project_proofs p
         LEFT JOIN employees e ON e.id = p.uploaded_by
        WHERE p.project_id = $1
        ORDER BY p.version DESC`,
      [projectId]
    );
    res.json({
      proofs: rows.map((r) => ({
        ...r,
        image_url: proofPublicUrl(r.project_id, r.file_path),
        approval_url: `${PUBLIC_SHOP_URL}/proofs/${r.token}`,
      })),
    });
  } catch (err) { next(err); }
});

// ─── PATCH /api/projects/:id/proofs/:proofId/annotations ─────────────────────
// Staff can add or revise their own annotations on a proof (e.g. to mark
// up before sending v2, or to reply to customer markup).
router.patch('/projects/:id/proofs/:proofId/annotations', requireStaff, express.json(), async (req, res, next) => {
  try {
    const projectId = parseInt(req.params.id, 10);
    const proofId = parseInt(req.params.proofId, 10);
    if (!Number.isInteger(projectId) || !Number.isInteger(proofId)) {
      return res.status(400).json({ message: 'invalid id' });
    }
    const annotations = Array.isArray(req.body?.annotations) ? req.body.annotations : null;
    if (!annotations) return res.status(400).json({ message: 'annotations array required' });
    const row = await queryOne(
      `UPDATE project_proofs SET annotations = $1::jsonb
        WHERE id = $2 AND project_id = $3
        RETURNING id, annotations`,
      [JSON.stringify(annotations), proofId, projectId]
    );
    if (!row) return res.status(404).json({ message: 'proof not found' });
    res.json(row);
  } catch (err) { next(err); }
});

// ─── DELETE /api/projects/:id/proofs/:proofId ────────────────────────────────
// Hard-delete a proof row (and best-effort WHC unlink). Refuses if the
// customer has already responded — preserve audit history.
router.delete('/projects/:id/proofs/:proofId', requireStaff, async (req, res, next) => {
  try {
    const projectId = parseInt(req.params.id, 10);
    const proofId = parseInt(req.params.proofId, 10);
    if (!Number.isInteger(projectId) || !Number.isInteger(proofId)) {
      return res.status(400).json({ message: 'invalid id' });
    }
    const proof = await queryOne(
      `SELECT id, project_id, file_path, status, responded_at
         FROM project_proofs
        WHERE id = $1 AND project_id = $2`,
      [proofId, projectId]
    );
    if (!proof) return res.status(404).json({ message: 'proof not found' });
    if (proof.responded_at) {
      return res.status(409).json({ message: 'Customer has already responded — keep this version for audit.' });
    }
    await query(`DELETE FROM project_proofs WHERE id = $1`, [proofId]);
    // Best-effort WHC unlink. Failure doesn't block — the DB row is gone.
    (async () => {
      let c;
      try {
        c = await connectFtp(15000);
        const remoteDir = `${WHC_REMOTE_BASE}/${projectId}/proofs`;
        await c.remove(`${remoteDir}/${proof.file_path}`).catch(() => {});
      } catch (e) { console.warn('[project-proofs] WHC unlink failed:', e.message); }
      finally { if (c) c.close(); }
    })();
    res.status(204).end();
  } catch (err) { next(err); }
});

// ═════════════════════════════════════════════════════════════════════════════
// CUSTOMER (no auth — token only)
// ═════════════════════════════════════════════════════════════════════════════

async function loadProofByToken(token) {
  return queryOne(
    `SELECT p.*,
            pr.description AS project_name,
            pr.contact_name AS project_contact_name,
            COALESCE(cl.company, CONCAT_WS(' ', cl.fname, cl.lname)) AS client_name,
            pr.production_emp_id AS assigned_emp_id,
            TRIM(CONCAT_WS(' ', e.first_name, e.last_name)) AS assigned_name,
            e.email AS assigned_email
       FROM project_proofs p
       JOIN projects pr ON pr.id = p.project_id
       LEFT JOIN clients   cl ON cl.id = pr.client_id
       LEFT JOIN employees e  ON e.id  = pr.production_emp_id
      WHERE p.token = $1`,
    [token]
  );
}

// GET /api/proofs/by-token/:token — view proof + mark first-viewed
router.get('/proofs/by-token/:token', async (req, res, next) => {
  try {
    const proof = await loadProofByToken(req.params.token);
    if (!proof) return res.status(404).json({ message: 'Proof not found or link expired' });

    // First-view stamp (only the very first GET — subsequent views don't bump).
    if (!proof.first_viewed_at && proof.status === 'sent') {
      await query(
        `UPDATE project_proofs SET first_viewed_at = NOW(), status = 'viewed'
          WHERE id = $1 AND first_viewed_at IS NULL`,
        [proof.id]
      );
      proof.first_viewed_at = new Date().toISOString();
      proof.status = 'viewed';
    }

    res.json({
      proof: {
        id:             proof.id,
        project_id:     proof.project_id,
        version:        proof.version,
        status:         proof.status,
        project_name:   proof.project_name,
        client_name:    proof.client_name,
        assigned_name:  proof.assigned_name,
        uploaded_at:    proof.uploaded_at,
        first_viewed_at: proof.first_viewed_at,
        responded_at:   proof.responded_at,
        response_name:  proof.response_name,
        response_text:  proof.response_text,
        annotations:    proof.annotations || [],
        image_url:      proofPublicUrl(proof.project_id, proof.file_path),
        file_mime:      proof.file_mime,
      },
    });
  } catch (err) { next(err); }
});

async function respondCommon(req, res, kind) {
  const body = req.body || {};
  const name = String(body.name || '').trim().slice(0, 200);
  const text = String(body.text || '').trim().slice(0, 4000);
  const annotations = Array.isArray(body.annotations) ? body.annotations : [];

  if (!name) return res.status(400).json({ message: 'Please type your name to confirm.' });
  if (kind === 'changes' && !text && annotations.length === 0) {
    return res.status(400).json({ message: 'Please describe the changes or annotate the proof.' });
  }

  const proof = await loadProofByToken(req.params.token);
  if (!proof) return res.status(404).json({ message: 'Proof not found' });
  if (proof.responded_at) {
    return res.status(409).json({ message: `This proof was already ${proof.status === 'approved' ? 'approved' : 'replied to'} on ${new Date(proof.responded_at).toLocaleDateString('en-CA')}.` });
  }
  if (proof.status === 'superseded') {
    return res.status(409).json({ message: 'This proof has been replaced by a newer version. Check your inbox for the latest link.' });
  }

  const newStatus = kind === 'approve' ? 'approved' : 'changes_requested';
  const ip = (req.headers['x-forwarded-for'] || '').toString().split(',')[0].trim() || req.ip || null;
  const ua = (req.headers['user-agent'] || '').toString().slice(0, 500) || null;

  await query(
    `UPDATE project_proofs
        SET status = $1, responded_at = NOW(),
            response_name = $2, response_text = $3,
            response_ip = $4, response_ua = $5,
            annotations = $6::jsonb
      WHERE id = $7`,
    [newStatus, name, text || null, ip, ua, JSON.stringify(annotations), proof.id]
  );

  // Auto-bump project status on approval if configured.
  if (kind === 'approve' && Number.isInteger(proof.approve_status_id)) {
    await query(`UPDATE projects SET status_id = $1 WHERE id = $2`, [proof.approve_status_id, proof.project_id]);
  }

  // Post into the Messages tab so the thread captures the response.
  const summary = kind === 'approve'
    ? `✅ ${name} approved proof v${proof.version}.${text ? `\n\n${text}` : ''}`
    : `✏️ ${name} requested changes on proof v${proof.version}:\n\n${text || '(no text — see annotations)'}`;
  await query(
    `INSERT INTO project_messages (project_id, author_type, author_id, author_name, body)
     VALUES ($1, 'customer', NULL, $2, $3)`,
    [proof.project_id, name, summary]
  );

  // Notify assigned staff (or fall back to SHOP_QUOTES_TO via mailer).
  mailer.sendProjectProofResponseToStaff({
    recipientEmail: proof.assigned_email || null,
    projectId: proof.project_id, projectName: proof.project_name,
    version: proof.version, kind, customerName: name, text,
    annotationsCount: annotations.length,
    jobUrl: `${PUBLIC_SHOP_URL}/jobs/${proof.project_id}`,
  }).catch((e) => console.warn('[project-proofs] staff notify failed:', e.message));

  res.json({
    ok: true, status: newStatus,
    message: kind === 'approve' ? 'Thanks — your approval is recorded.' : "Thanks — we'll send a revised proof shortly.",
  });
}

router.post('/proofs/by-token/:token/approve', express.json(), (req, res, next) => {
  respondCommon(req, res, 'approve').catch(next);
});

router.post('/proofs/by-token/:token/request-changes', express.json(), (req, res, next) => {
  respondCommon(req, res, 'changes').catch(next);
});

module.exports = router;
