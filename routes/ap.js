// routes/ap.js
// Accounts-payable document pipeline: intake → extraction → review → QBO.
// Mounted at /api/ap.
//
// The flow a bill takes:
//   POST /documents            upload (or POST /inbound from a mail rule)
//     → extraction runs in the background, row sits in 'needs_review'
//   GET  /documents?review_status=needs_review    the review queue
//   PATCH /documents/:id       reviewer corrects anything the model got wrong
//   POST /documents/:id/vendor assign the QBO vendor (and teach the alias)
//   POST /documents/:id/approve
//   POST /documents/:id/post   creates the QBO Bill, attaches the PDF
//
// And for statements:
//   POST /statements/:id/reconcile   diffs the statement against the books
//
// Auth: staff can upload, review and correct. Only an admin can post to
// QuickBooks or purge a stored file — those are the two actions that touch
// the accounting or destroy data.

'use strict';

const express = require('express');
const multer  = require('multer');
const crypto  = require('crypto');

const { query, queryOne } = require('../db/connection');
const { requireStaff, requireAdmin } = require('../middleware/auth');
const { ingestDocument, runExtraction, upsertStatement } = require('../lib/ap-intake');
const { normalizeVendor } = require('../lib/ap-extract');
const {
  postBillForDocument, resolveVendor, learnVendorAlias, searchVendors,
  listExpenseAccounts,
} = require('../lib/ap-qbo-bills');
const { reconcileStatement } = require('../lib/ap-reconcile');

const router = express.Router();

// The Messages API caps a base64 PDF request at 32MB; anything larger can be
// stored but never read, so it is rejected at the door instead.
const UPLOAD_MAX_BYTES = 30 * 1024 * 1024;

const upload = multer({
  storage: multer.memoryStorage(),
  limits:  { fileSize: UPLOAD_MAX_BYTES, files: 10 },
});

const ALLOWED_MIME = new Set([
  'application/pdf',
  'image/jpeg',
  'image/png',
]);

// Extraction takes tens of seconds, so it never runs inside the request.
// Failures are already recorded on the row by runExtraction; this only
// catches a throw from the DB write itself so it can't take the process
// down as an unhandled rejection.
function extractInBackground(documentId) {
  runExtraction(documentId).catch((err) => {
    console.error(`[ap] background extraction failed for doc ${documentId}:`, err.message);
  });
}

// ─── Upload ──────────────────────────────────────────────────────────────
// POST /api/ap/documents   (multipart, field name `files`, up to 10)
router.post('/documents', requireStaff, upload.array('files', 10), async (req, res) => {
  try {
    const files = req.files || [];
    if (files.length === 0) {
      return res.status(400).json({ error: 'No files uploaded (field name must be "files")' });
    }

    const results = [];
    for (const f of files) {
      if (!ALLOWED_MIME.has(f.mimetype)) {
        results.push({ filename: f.originalname, error: `Unsupported type ${f.mimetype}` });
        continue;
      }
      try {
        const r = await ingestDocument({
          buffer:   f.buffer,
          filename: f.originalname,
          mimeType: f.mimetype,
          source:   'upload',
        });
        if (!r.duplicate) extractInBackground(r.id);
        results.push({ filename: f.originalname, ...r });
      } catch (err) {
        results.push({ filename: f.originalname, error: err.message });
      }
    }

    res.status(201).json({ documents: results });
  } catch (err) {
    console.error('[ap] upload failed:', err);
    res.status(500).json({ error: err.message });
  }
});

// ─── Webhook intake ──────────────────────────────────────────────────────
// POST /api/ap/inbound   { filename, content_base64, source? }
//
// For a mail rule, a folder watcher, or the Cloudflare email worker. Auth is
// a shared secret rather than a staff JWT because the caller is a machine
// with no session. Fails closed when the secret isn't configured, the same
// way routes/inbound-email.js does.
router.post('/inbound', express.json({ limit: '40mb' }), async (req, res) => {
  const secret = process.env.AP_INBOUND_SECRET;
  if (!secret) {
    return res.status(503).json({ error: 'AP inbound not configured' });
  }
  const presented = req.headers['x-ap-secret'] || '';
  // Constant-time compare so a wrong secret can't be recovered by timing.
  const a = Buffer.from(String(presented));
  const b = Buffer.from(secret);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  try {
    const { filename, content_base64, source = 'email', mime_type = 'application/pdf' } = req.body || {};
    if (!content_base64) return res.status(400).json({ error: 'content_base64 required' });

    const buffer = Buffer.from(content_base64, 'base64');
    if (buffer.length === 0)                return res.status(400).json({ error: 'Empty file' });
    if (buffer.length > UPLOAD_MAX_BYTES)   return res.status(413).json({ error: 'File too large' });

    const r = await ingestDocument({ buffer, filename, source, mimeType: mime_type });
    if (!r.duplicate) extractInBackground(r.id);
    res.status(201).json(r);
  } catch (err) {
    console.error('[ap] inbound failed:', err);
    res.status(500).json({ error: err.message });
  }
});

// ─── List / read ─────────────────────────────────────────────────────────
// GET /api/ap/documents?review_status=&doc_kind=&posted=&vendor_qbo_id=&limit=
router.get('/documents', requireStaff, async (req, res) => {
  try {
    const where  = [];
    const params = [];
    const add = (sql, value) => { params.push(value); where.push(sql.replace('?', `$${params.length}`)); };

    if (req.query.review_status) add('review_status = ?', req.query.review_status);
    if (req.query.doc_kind)      add('doc_kind = ?',      req.query.doc_kind);
    if (req.query.vendor_qbo_id) add('vendor_qbo_id = ?', req.query.vendor_qbo_id);
    if (req.query.extract_status) add('extract_status = ?', req.query.extract_status);
    if (req.query.posted === 'true')  where.push('posted_at IS NOT NULL');
    if (req.query.posted === 'false') where.push('posted_at IS NULL');

    const limit = Math.min(Number(req.query.limit) || 100, 500);

    // file_bytes is deliberately not selected — a list of 100 documents
    // would otherwise pull tens of megabytes of PDF through the pool to
    // render a table of totals.
    const rows = await query(
      `SELECT id, source, original_filename, doc_kind, extract_status, extract_error,
              extract_confidence, vendor_name, vendor_qbo_id, doc_number, txn_date,
              due_date, terms, currency, subtotal_cents, tax_cents, total_cents,
              review_status, qbo_bill_id, posted_at, post_error,
              (file_bytes IS NOT NULL) AS has_file, byte_size, created_at
         FROM ap_documents
        ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
        ORDER BY created_at DESC
        LIMIT ${limit}`,
      params
    );
    res.json({ documents: rows });
  } catch (err) {
    console.error('[ap] list failed:', err);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/ap/documents/:id
router.get('/documents/:id', requireStaff, async (req, res) => {
  try {
    const doc = await queryOne(
      `SELECT id, source, original_filename, content_sha256, mime_type, byte_size,
              doc_kind, extract_status, extract_error, extract_model, extracted_at,
              extract_raw, extract_confidence, vendor_name, vendor_qbo_id, doc_number,
              txn_date, due_date, terms, currency, subtotal_cents, tax_cents,
              total_cents, memo, review_status, reviewed_by, reviewed_at,
              qbo_bill_id, qbo_attachable_id, posted_at, post_error,
              (file_bytes IS NOT NULL) AS has_file, file_purged_at,
              created_at, updated_at
         FROM ap_documents WHERE id = $1`,
      [req.params.id]
    );
    if (!doc) return res.status(404).json({ error: 'Not found' });

    const lines = await query(
      `SELECT * FROM ap_document_lines WHERE document_id = $1 ORDER BY line_no`,
      [req.params.id]
    );
    const statement = await queryOne(
      `SELECT * FROM ap_statements WHERE document_id = $1`,
      [req.params.id]
    );

    res.json({ document: doc, lines, statement });
  } catch (err) {
    console.error('[ap] get failed:', err);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/ap/documents/:id/file — the source PDF, for the review pane.
router.get('/documents/:id/file', requireStaff, async (req, res) => {
  try {
    const doc = await queryOne(
      `SELECT file_bytes, mime_type, original_filename, file_purged_at
         FROM ap_documents WHERE id = $1`,
      [req.params.id]
    );
    if (!doc) return res.status(404).json({ error: 'Not found' });
    if (!doc.file_bytes) {
      return res.status(410).json({
        error: doc.file_purged_at
          ? 'File was purged after posting — the copy in QuickBooks is the surviving one'
          : 'No file stored',
      });
    }

    res.set('Content-Type', doc.mime_type || 'application/pdf');
    res.set('Content-Disposition',
      `inline; filename="${(doc.original_filename || 'document.pdf').replace(/"/g, '')}"`);
    res.send(doc.file_bytes);
  } catch (err) {
    console.error('[ap] file fetch failed:', err);
    res.status(500).json({ error: err.message });
  }
});

// ─── Re-extract ──────────────────────────────────────────────────────────
// POST /api/ap/documents/:id/extract — re-run after a failure, or after a
// model change. Synchronous: the caller asked for this one specifically and
// wants the answer.
router.post('/documents/:id/extract', requireStaff, async (req, res) => {
  try {
    const posted = await queryOne(`SELECT posted_at FROM ap_documents WHERE id = $1`, [req.params.id]);
    if (!posted) return res.status(404).json({ error: 'Not found' });
    if (posted.posted_at) {
      return res.status(409).json({ error: 'Already posted to QuickBooks; re-extraction would desync the two' });
    }
    const result = await runExtraction(req.params.id);
    res.json(result);
  } catch (err) {
    console.error('[ap] extract failed:', err);
    res.status(500).json({ error: err.message });
  }
});

// ─── Reviewer corrections ────────────────────────────────────────────────
// PATCH /api/ap/documents/:id
// Body may carry any header field plus a full `lines` array, which REPLACES
// the existing lines.
const EDITABLE = [
  'doc_kind', 'vendor_name', 'doc_number', 'txn_date', 'due_date', 'terms',
  'currency', 'subtotal_cents', 'tax_cents', 'total_cents', 'memo',
];

router.patch('/documents/:id', requireStaff, async (req, res) => {
  try {
    const doc = await queryOne(`SELECT id, posted_at FROM ap_documents WHERE id = $1`, [req.params.id]);
    if (!doc) return res.status(404).json({ error: 'Not found' });
    if (doc.posted_at) {
      return res.status(409).json({
        error: 'Already posted to QuickBooks — correct it in QBO, not here, or the two will disagree',
      });
    }

    const sets = [];
    const params = [];
    for (const field of EDITABLE) {
      if (Object.prototype.hasOwnProperty.call(req.body, field)) {
        params.push(req.body[field] === '' ? null : req.body[field]);
        sets.push(`${field} = $${params.length}`);
      }
    }

    if (sets.length) {
      params.push(req.params.id);
      await query(
        `UPDATE ap_documents SET ${sets.join(', ')}, updated_at = NOW() WHERE id = $${params.length}`,
        params
      );
    }

    if (Array.isArray(req.body.lines)) {
      await query(`DELETE FROM ap_document_lines WHERE document_id = $1`, [req.params.id]);
      let n = 0;
      for (const l of req.body.lines) {
        n += 1;
        await query(
          `INSERT INTO ap_document_lines
             (document_id, line_no, description, quantity, unit_cents, amount_cents,
              account_name, account_qbo_id, tax_code)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
          [
            req.params.id, n, l.description ?? null, l.quantity ?? null,
            l.unit_cents ?? null, l.amount_cents ?? 0,
            l.account_name ?? null, l.account_qbo_id ?? null, l.tax_code ?? null,
          ]
        );
      }
    }

    const updated = await queryOne(
      `SELECT id, doc_kind, vendor_name, vendor_qbo_id, doc_number, txn_date, due_date,
              terms, currency, subtotal_cents, tax_cents, total_cents, memo, review_status
         FROM ap_documents WHERE id = $1`,
      [req.params.id]
    );
    const lines = await query(
      `SELECT * FROM ap_document_lines WHERE document_id = $1 ORDER BY line_no`,
      [req.params.id]
    );
    res.json({ document: updated, lines });
  } catch (err) {
    console.error('[ap] patch failed:', err);
    res.status(500).json({ error: err.message });
  }
});

// ─── Vendor assignment ───────────────────────────────────────────────────
// GET /api/ap/vendors?q=sanmar — picker for the review screen.
router.get('/vendors', requireStaff, async (req, res) => {
  try {
    res.json({ vendors: await searchVendors(req.query.q) });
  } catch (err) {
    console.error('[ap] vendor search failed:', err);
    res.status(502).json({ error: `QuickBooks lookup failed: ${err.message}` });
  }
});

// GET /api/ap/accounts — the expense side of the chart of accounts, for the
// per-line coding dropdown on the review screen.
router.get('/accounts', requireStaff, async (req, res) => {
  try {
    res.json({ accounts: await listExpenseAccounts() });
  } catch (err) {
    console.error('[ap] account list failed:', err);
    res.status(502).json({ error: `QuickBooks lookup failed: ${err.message}` });
  }
});

// POST /api/ap/documents/:id/vendor   { vendor_qbo_id, vendor_name, learn }
//
// `learn` (default true) records the alias so every future document from
// this supplier resolves on its own. That is what makes the review queue
// shrink over time instead of asking the same question every month.
router.post('/documents/:id/vendor', requireStaff, async (req, res) => {
  try {
    const { vendor_qbo_id, vendor_name, learn = true } = req.body || {};
    if (!vendor_qbo_id) return res.status(400).json({ error: 'vendor_qbo_id required' });

    const doc = await queryOne(
      `SELECT id, vendor_name, posted_at FROM ap_documents WHERE id = $1`,
      [req.params.id]
    );
    if (!doc) return res.status(404).json({ error: 'Not found' });
    if (doc.posted_at) return res.status(409).json({ error: 'Already posted to QuickBooks' });

    await query(
      `UPDATE ap_documents SET vendor_qbo_id = $1, vendor_name = COALESCE($2, vendor_name),
              updated_at = NOW()
        WHERE id = $3`,
      [vendor_qbo_id, vendor_name || null, req.params.id]
    );

    // The alias is keyed on what the DOCUMENT said, not on the QBO name —
    // matching the document is the whole job.
    if (learn) {
      const aliasNorm = normalizeVendor(doc.vendor_name);
      if (aliasNorm) {
        await learnVendorAlias({ aliasNorm, vendorQboId: vendor_qbo_id, vendorName: vendor_name });
      }
    }

    // A statement carries its own vendor column, used by the reconciler.
    await query(
      `UPDATE ap_statements SET vendor_qbo_id = $1, vendor_name = COALESCE($2, vendor_name)
        WHERE document_id = $3`,
      [vendor_qbo_id, vendor_name || null, req.params.id]
    );

    res.json({ ok: true, vendor_qbo_id, learned: !!learn });
  } catch (err) {
    console.error('[ap] vendor assign failed:', err);
    res.status(500).json({ error: err.message });
  }
});

// ─── Approve / reject ────────────────────────────────────────────────────
router.post('/documents/:id/approve', requireStaff, async (req, res) => {
  try {
    const doc = await queryOne(
      `SELECT id, vendor_qbo_id, total_cents, doc_kind FROM ap_documents WHERE id = $1`,
      [req.params.id]
    );
    if (!doc) return res.status(404).json({ error: 'Not found' });

    // Approval is the gate before money moves, so the fields the QBO post
    // needs are checked here rather than failing later at the API boundary.
    const problems = [];
    if (!doc.vendor_qbo_id) problems.push('no QuickBooks vendor assigned');
    if (doc.doc_kind === 'invoice' || doc.doc_kind === 'credit_note') {
      const lines = await query(
        `SELECT COALESCE(SUM(amount_cents), 0) AS total, COUNT(*) AS n
           FROM ap_document_lines WHERE document_id = $1`,
        [req.params.id]
      );
      if (Number(lines[0].n) === 0) problems.push('no lines to post');
    }
    if (problems.length) {
      return res.status(400).json({ error: `Cannot approve: ${problems.join('; ')}` });
    }

    await query(
      `UPDATE ap_documents
          SET review_status = 'approved', reviewed_by = $1, reviewed_at = NOW(), updated_at = NOW()
        WHERE id = $2`,
      [req.user.id, req.params.id]
    );
    res.json({ ok: true, review_status: 'approved' });
  } catch (err) {
    console.error('[ap] approve failed:', err);
    res.status(500).json({ error: err.message });
  }
});

router.post('/documents/:id/reject', requireStaff, async (req, res) => {
  try {
    const r = await query(
      `UPDATE ap_documents
          SET review_status = 'rejected', reviewed_by = $1, reviewed_at = NOW(),
              memo = COALESCE($2, memo), updated_at = NOW()
        WHERE id = $3 AND posted_at IS NULL
        RETURNING id`,
      [req.user.id, req.body?.reason || null, req.params.id]
    );
    if (r.length === 0) {
      return res.status(409).json({ error: 'Not found, or already posted to QuickBooks' });
    }
    res.json({ ok: true, review_status: 'rejected' });
  } catch (err) {
    console.error('[ap] reject failed:', err);
    res.status(500).json({ error: err.message });
  }
});

// ─── Post to QuickBooks ──────────────────────────────────────────────────
// POST /api/ap/documents/:id/post   (admin only — this creates a payable)
router.post('/documents/:id/post', requireAdmin, async (req, res) => {
  try {
    const result = await postBillForDocument(req.params.id);
    res.json(result);
  } catch (err) {
    console.error(`[ap] post failed for doc ${req.params.id}:`, err.message);
    res.status(502).json({ error: err.message, qbCode: err.qbCode || null });
  }
});

// POST /api/ap/documents/:id/purge-file — drop our copy of the PDF once QBO
// holds the attachment. Admin only: it destroys data, and it is refused
// unless the attachment actually made it, so the source is never the thing
// that vanishes after a failed attach.
router.post('/documents/:id/purge-file', requireAdmin, async (req, res) => {
  try {
    const doc = await queryOne(
      `SELECT id, qbo_bill_id, qbo_attachable_id FROM ap_documents WHERE id = $1`,
      [req.params.id]
    );
    if (!doc) return res.status(404).json({ error: 'Not found' });
    if (!doc.qbo_bill_id || !doc.qbo_attachable_id) {
      return res.status(409).json({
        error: 'Refusing to purge: QuickBooks does not hold an attachment for this document',
      });
    }
    await query(
      `UPDATE ap_documents SET file_bytes = NULL, file_purged_at = NOW(), updated_at = NOW()
        WHERE id = $1`,
      [req.params.id]
    );
    res.json({ ok: true });
  } catch (err) {
    console.error('[ap] purge failed:', err);
    res.status(500).json({ error: err.message });
  }
});

// ─── Statements ──────────────────────────────────────────────────────────
router.get('/statements', requireStaff, async (req, res) => {
  try {
    const rows = await query(
      `SELECT s.*, d.original_filename, d.extract_status
         FROM ap_statements s
         JOIN ap_documents d ON d.id = s.document_id
        ORDER BY s.statement_date DESC NULLS LAST, s.id DESC
        LIMIT 200`
    );
    res.json({ statements: rows });
  } catch (err) {
    console.error('[ap] statement list failed:', err);
    res.status(500).json({ error: err.message });
  }
});

router.get('/statements/:id', requireStaff, async (req, res) => {
  try {
    const stmt = await queryOne(`SELECT * FROM ap_statements WHERE id = $1`, [req.params.id]);
    if (!stmt) return res.status(404).json({ error: 'Not found' });
    const lines = await query(
      `SELECT * FROM ap_statement_lines WHERE statement_id = $1 ORDER BY line_no`,
      [req.params.id]
    );
    res.json({ statement: stmt, lines });
  } catch (err) {
    console.error('[ap] statement get failed:', err);
    res.status(500).json({ error: err.message });
  }
});

// POST /api/ap/statements/:id/reconcile — the payoff. Diffs the statement
// against QBO plus anything we hold but haven't posted.
router.post('/statements/:id/reconcile', requireStaff, async (req, res) => {
  try {
    const result = await reconcileStatement(req.params.id);
    res.json(result);
  } catch (err) {
    console.error(`[ap] reconcile failed for statement ${req.params.id}:`, err.message);
    res.status(502).json({ error: err.message });
  }
});

// Rebuilds statement header + lines from the stored extraction, for a
// statement whose lines were edited into a mess or that predates a fix to
// the extractor. Cheap: it re-reads extract_raw, it does not re-call the model.
router.post('/documents/:id/rebuild-statement', requireStaff, async (req, res) => {
  try {
    const doc = await queryOne(
      `SELECT id, doc_kind, extract_raw, vendor_qbo_id, vendor_name FROM ap_documents WHERE id = $1`,
      [req.params.id]
    );
    if (!doc) return res.status(404).json({ error: 'Not found' });
    if (doc.doc_kind !== 'statement') {
      return res.status(400).json({ error: `Document is a ${doc.doc_kind}, not a statement` });
    }
    if (!doc.extract_raw) return res.status(400).json({ error: 'No stored extraction to rebuild from' });

    const { normalizeExtraction } = require('../lib/ap-extract');
    // extract_raw is { first_pass, gap_pass? } on anything extracted since the
    // second pass shipped, and the bare model output on rows written before
    // it. Statements never trigger a gap pass, so first_pass is the whole
    // answer whenever it is present.
    const rawDoc = doc.extract_raw.first_pass || doc.extract_raw;
    const result = normalizeExtraction(rawDoc);
    const statementId = await upsertStatement(
      doc.id, result,
      doc.vendor_qbo_id ? { id: doc.vendor_qbo_id } : null
    );
    res.json({ ok: true, statement_id: statementId, lines: result.statement_lines.length });
  } catch (err) {
    console.error('[ap] rebuild statement failed:', err);
    res.status(500).json({ error: err.message });
  }
});

// ─── Multer error surface ────────────────────────────────────────────────
// Without this, an oversized upload returns a bare 500 with no clue which
// limit was hit.
router.use((err, _req, res, next) => {
  if (err instanceof multer.MulterError) {
    const msg = err.code === 'LIMIT_FILE_SIZE'
      ? `File too large (max ${Math.floor(UPLOAD_MAX_BYTES / 1024 / 1024)}MB)`
      : err.message;
    return res.status(400).json({ error: msg, code: err.code });
  }
  return next(err);
});

module.exports = router;
