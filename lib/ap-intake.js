// lib/ap-intake.js
// Gets a supplier PDF into ap_documents and runs extraction over it.
//
// Split from routes/ap.js because three different intake paths share it:
// the staff upload form, the inbound webhook a mail rule or folder watcher
// posts to, and a manual re-extract of a document that failed the first
// time.
//
// ingestDocument() is deliberately fast and synchronous-safe: it hashes,
// dedupes, and stores, then returns. Extraction is a separate call because
// it takes tens of seconds and must not sit inside an HTTP request that a
// proxy will time out. Callers kick it off with .catch() and let the
// reviewer poll, the same fire-and-forget shape routes/orders.js uses for
// the QBO sales-receipt push.

'use strict';

const crypto = require('crypto');
const { query, queryOne } = require('../db/connection');
const { extractDocument, normalizeVendor } = require('./ap-extract');
const { resolveVendor, suggestAccountForVendor, HST_TAX_CODE } = require('./ap-qbo-bills');
const { splitByRanges, partFilename } = require('./ap-split');

// ─── Intake ──────────────────────────────────────────────────────────────
async function ingestDocument({ buffer, filename, source = 'upload', mimeType = 'application/pdf' }) {
  if (!Buffer.isBuffer(buffer) || buffer.length === 0) {
    throw new Error('ingestDocument: a non-empty file buffer is required');
  }

  const sha = crypto.createHash('sha256').update(buffer).digest('hex');

  // The same PDF forwarded twice is one document, not two bills. Returning
  // the existing row (rather than erroring) is what lets a mail rule replay
  // a folder without any bookkeeping of its own.
  const existing = await queryOne(
    `SELECT id, extract_status FROM ap_documents WHERE content_sha256 = $1`,
    [sha]
  );
  if (existing) {
    return { id: existing.id, duplicate: true, extract_status: existing.extract_status };
  }

  const row = await queryOne(
    `INSERT INTO ap_documents
       (source, original_filename, content_sha256, mime_type, byte_size, file_bytes)
     VALUES ($1, $2, $3, $4, $5, $6)
     RETURNING id`,
    [source, filename || null, sha, mimeType, buffer.length, buffer]
  );

  return { id: row.id, duplicate: false, extract_status: 'pending' };
}

// ─── Extraction ──────────────────────────────────────────────────────────
// Writes the model's answer onto the row. Never throws to the caller's
// request path: a failure is recorded on the row so the document stays in
// the queue with a readable reason instead of disappearing.
async function runExtraction(documentId) {
  const doc = await queryOne(
    `SELECT id, file_bytes, original_filename, mime_type, file_purged_at
       FROM ap_documents WHERE id = $1`,
    [documentId]
  );
  if (!doc) throw new Error(`ap_documents ${documentId} not found`);
  if (!doc.file_bytes) {
    const why = doc.file_purged_at
      ? 'file was purged after posting'
      : 'no file bytes stored';
    await markFailed(documentId, `Cannot extract: ${why}`);
    return { ok: false, error: why };
  }

  let result;
  try {
    result = await extractDocument({
      buffer:   doc.file_bytes,
      filename: doc.original_filename || `document-${documentId}.pdf`,
    });
  } catch (err) {
    await markFailed(documentId, err.message);
    return { ok: false, error: err.message };
  }

  // A month-end reprint bundle: several separate invoices in one PDF. Split
  // it and read each one on its own, rather than recording the first and
  // losing the rest.
  if (result.document_pages?.length >= 2) {
    const split = await splitBundle(doc, result);
    if (split) return split;

    // The split was refused, which means the page ranges did not account for
    // every page. Recording the file as the single invoice the rest of this
    // function assumes would put ONE bill in the queue for a file holding
    // several, and the reviewer has no way to tell that from a normal
    // invoice. Fail it instead, and say what to do about it: a document in
    // the queue with a readable reason is the whole point of the queue.
    const why =
      `This file appears to hold ${result.document_pages.length} separate invoices, ` +
      `but the pages could not be divided between them reliably, so it has not been split. ` +
      `Split the PDF into one file per invoice and upload them again.`;
    await markFailed(documentId, why);
    return { ok: false, error: why };
  }

  // Resolve the vendor now rather than at review time, so a supplier we
  // have seen before arrives already coded and the reviewer only looks at
  // the ones that are genuinely new.
  let vendor = null;
  try {
    vendor = await resolveVendor({ name: result.vendor_name, norm: result.vendor_norm });
  } catch (err) {
    // QBO being down must not fail extraction — the text is still good, and
    // the vendor can be assigned by hand.
    console.warn(`[ap-intake] vendor lookup failed for doc ${documentId}: ${err.message}`);
  }

  await query(
    `UPDATE ap_documents SET
        doc_kind = $1, extract_status = 'ok', extract_error = NULL,
        extract_model = $2, extracted_at = NOW(), extract_raw = $3,
        extract_confidence = $4,
        vendor_name = $5, vendor_qbo_id = $6, doc_number = $7,
        txn_date = $8, due_date = $9, terms = $10, currency = $11,
        subtotal_cents = $12, tax_cents = $13, total_cents = $14, memo = $15,
        updated_at = NOW()
      WHERE id = $16`,
    [
      result.doc_kind, result.model, JSON.stringify(result.raw), result.confidence,
      result.vendor_name, vendor?.id || null, result.doc_number,
      result.txn_date, result.due_date, result.terms, result.currency,
      result.subtotal_cents, result.tax_cents, result.total_cents, result.memo,
      documentId,
    ]
  );

  // What this vendor's lines have been coded to before. Freight goes to
  // Shipping every time, materials to the same materials account every time,
  // so the second invoice from a supplier arrives already coded and the
  // reviewer only touches the exceptions.
  let suggested = null;
  if (vendor?.id) {
    try {
      suggested = await suggestAccountForVendor(vendor.id);
    } catch (err) {
      console.warn(`[ap-intake] account suggestion failed for doc ${documentId}: ${err.message}`);
    }
  }

  // Lines are replaced wholesale on every extraction run so a re-extract
  // can't leave half of a previous attempt behind.
  await query(`DELETE FROM ap_document_lines WHERE document_id = $1`, [documentId]);
  for (const line of result.lines) {
    await query(
      `INSERT INTO ap_document_lines
         (document_id, line_no, description, quantity, unit_cents, amount_cents,
          account_qbo_id, account_name, tax_code)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [
        documentId, line.line_no, line.description, line.quantity,
        line.unit_cents, line.amount_cents,
        suggested?.id   || null,
        suggested?.name || null,
        // Default every line to HST. Canadian supplier invoices are taxable
        // far more often than not, and a reviewer clearing the code on the
        // exceptions is less error-prone than remembering to set it on the
        // rest — an unset code silently forfeits the input tax credit.
        result.tax_cents ? HST_TAX_CODE : null,
      ]
    );
  }

  // A statement gets its own header row and lines, ready to reconcile.
  if (result.doc_kind === 'statement') {
    await upsertStatement(documentId, result, vendor);
  }

  return {
    ok: true,
    doc_kind:   result.doc_kind,
    confidence: result.confidence,
    vendor:     vendor,
    lines:      result.lines.length,
    statement_lines: result.statement_lines.length,
  };
}

async function upsertStatement(documentId, result, vendor) {
  const stmt = await queryOne(
    `INSERT INTO ap_statements
       (document_id, vendor_name, vendor_qbo_id, statement_date, closing_balance_cents)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (document_id) DO UPDATE SET
       vendor_name           = EXCLUDED.vendor_name,
       vendor_qbo_id         = EXCLUDED.vendor_qbo_id,
       statement_date        = EXCLUDED.statement_date,
       closing_balance_cents = EXCLUDED.closing_balance_cents,
       reconciled_at         = NULL,
       summary               = NULL
     RETURNING id`,
    [
      documentId, result.vendor_name, vendor?.id || null,
      result.txn_date, result.total_cents,
    ]
  );

  await query(`DELETE FROM ap_statement_lines WHERE statement_id = $1`, [stmt.id]);
  for (const line of result.statement_lines) {
    await query(
      `INSERT INTO ap_statement_lines
         (statement_id, line_no, doc_number, txn_date, amount_cents, kind,
          finance_charge_cents)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [stmt.id, line.line_no, line.doc_number, line.txn_date, line.amount_cents, line.kind,
       line.finance_charge_cents ?? null]
    );
  }

  return stmt.id;
}

/**
 * Turn a bundle into one document per invoice.
 *
 * The parent keeps the file that actually arrived — it is the evidence the
 * split was right, and without it nobody could ever check — and is marked as a
 * bundle so it drops out of the review queue. Each child gets only its own
 * pages, so the right pages attach to the right bill in QuickBooks.
 *
 * Returns null when the split cannot be trusted, leaving the caller to read
 * the file as a single document.
 */
async function splitBundle(doc, result) {
  const ranges = result.document_pages;
  let parts;
  try {
    parts = await splitByRanges(doc.file_bytes, ranges);
  } catch (err) {
    console.warn(`[ap-intake] bundle split rejected for doc ${doc.id}: ${err.message}`);
    return null;
  }
  if (parts.length < 2) return null;

  const children = [];
  for (const [i, part] of parts.entries()) {
    // Each child is ingested like any other arrival, so the sha dedupe holds:
    // re-reading the same bundle finds the same children rather than making a
    // second set of bills.
    const child = await ingestDocument({
      buffer:   part.buffer,
      filename: partFilename(doc.original_filename, part, i),
      source:   'split',
    });

    await query(
      `UPDATE ap_documents
          SET parent_document_id = $1, page_from = $2, page_to = $3, updated_at = NOW()
        WHERE id = $4`,
      [doc.id, part.first_page, part.last_page, child.id]
    );

    children.push(child);
  }

  await query(
    `UPDATE ap_documents SET
        doc_kind = 'bundle', extract_status = 'ok', extract_error = NULL,
        extract_model = $1, extracted_at = NOW(), extract_raw = $2,
        extract_confidence = $3, vendor_name = $4,
        memo = $5, review_status = 'approved', reviewed_at = NOW(),
        updated_at = NOW()
      WHERE id = $6`,
    [
      result.model, JSON.stringify(result.raw), result.confidence, result.vendor_name,
      `Bundle of ${parts.length} invoices, split into separate documents`,
      doc.id,
    ]
  );

  // Read each invoice on its own. Sequential rather than parallel: this runs
  // behind a fire-and-forget call already, and a dozen concurrent extractions
  // would hit the model's rate limit for no gain in wall-clock the reviewer
  // would notice.
  for (const child of children) {
    if (child.duplicate) continue;
    try {
      await runExtraction(child.id);
    } catch (err) {
      console.warn(`[ap-intake] extraction failed for split child ${child.id}: ${err.message}`);
    }
  }

  return {
    ok: true,
    bundle: true,
    documentId: doc.id,
    children: children.map((c) => c.id),
  };
}

async function markFailed(documentId, message) {
  await query(
    `UPDATE ap_documents
        SET extract_status = 'failed', extract_error = $1, extracted_at = NOW(), updated_at = NOW()
      WHERE id = $2`,
    [String(message).slice(0, 2000), documentId]
  );
}

module.exports = { ingestDocument, runExtraction, upsertStatement, normalizeVendor };
