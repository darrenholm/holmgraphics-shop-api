// lib/ap-reread-bundle.js
//
// Re-read a document that was filed as one invoice but is really several.
//
// New arrivals split themselves (lib/ap-intake.js splitBundle), so this is for
// the ones that came in before that existed. Timbremart's August reprint pack
// is the case it was written for: seven invoices in one PDF, read as one,
// posted as one, and the other six lost. They only surfaced when the month-end
// statement listed six invoices nobody could find.
//
// WHY THE ORDINARY RE-READ BUTTON WILL NOT DO THIS. It refuses on a document
// already posted to QuickBooks, and rightly: re-reading one normally means the
// queue and the books stop agreeing about the same bill. A bundle is a
// different situation. The document is not WRONG, it is INCOMPLETE — the bill
// that was posted is real and stays real, and what is missing was never
// entered at all. So the posting record is handed to the child invoice it
// actually belongs to instead of being thrown away.
//
// NOTHING IS LOST IF IT TURNS OUT NOT TO BE A BUNDLE. The posting record is
// held aside, and put back exactly as it was unless the file genuinely splits.
// Pressing this on an ordinary invoice costs one extraction and changes
// nothing.

'use strict';

const { query, queryOne } = require('../db/connection');
const { runExtraction } = require('./ap-intake');
const { normalizeDocNumber } = require('./ap-reconcile');

/**
 * @param {number|string} documentId
 * @returns {Promise<object>} what happened, in terms a reviewer can act on
 */
async function rereadAsBundle(documentId) {
  const doc = await queryOne('SELECT * FROM ap_documents WHERE id = $1', [documentId]);
  if (!doc) throw new Error(`ap_documents ${documentId} not found`);

  if (doc.doc_kind === 'bundle') {
    return { ok: false, split: false, reason: 'This document has already been split into its invoices.' };
  }
  if (!doc.file_bytes) {
    return {
      ok: false, split: false,
      reason: 'The file has been purged, so there is nothing left to re-read. ' +
              'Upload the PDF again to split it.',
    };
  }

  // Held aside, not discarded. Restored below unless the file really splits.
  const posting = {
    qbo_bill_id:       doc.qbo_bill_id,
    qbo_attachable_id: doc.qbo_attachable_id,
    posted_at:         doc.posted_at,
    doc_number:        doc.doc_number,
    // Restored only when the run FAILS. A file that simply turns out to hold
    // one invoice has been re-read, and the fresh reading is the better one —
    // but a document left marked "could not read" because somebody pressed
    // this on an ordinary bill would be a new problem where there was none.
    extract_status:    doc.extract_status,
    extract_error:     doc.extract_error,
  };

  if (posting.qbo_bill_id || posting.posted_at) {
    await query(
      `UPDATE ap_documents
          SET qbo_bill_id = NULL, qbo_attachable_id = NULL, posted_at = NULL, updated_at = NOW()
        WHERE id = $1`,
      [documentId]
    );
  }

  let result;
  try {
    result = await runExtraction(documentId);
  } catch (err) {
    await restorePosting(documentId, posting, { restoreExtract: true });
    throw err;
  }

  if (!result || !result.bundle) {
    // Either the model found one invoice, or it found several and the page
    // ranges could not be trusted — in which case runExtraction has already
    // failed the document with a reason the reviewer can read. Either way the
    // bill that was posted is still the right bill, so it goes back.
    await restorePosting(documentId, posting, { restoreExtract: !(result && result.ok) });
    return {
      ok: false,
      split: false,
      reason: result && result.error
        ? result.error
        : 'The file reads as a single invoice, so there was nothing to split. Nothing has changed.',
    };
  }

  // It split. Hand the posted bill to the invoice it actually belongs to.
  const children = await query(
    `SELECT id, doc_number, total_cents, page_from, page_to
       FROM ap_documents WHERE parent_document_id = $1 ORDER BY page_from`,
    [documentId]
  );

  let inherited = null;
  if (posting.qbo_bill_id) {
    const want = normalizeDocNumber(posting.doc_number);
    const heir = children.find((c) => want && normalizeDocNumber(c.doc_number) === want);
    if (heir) {
      await query(
        `UPDATE ap_documents
            SET qbo_bill_id = $1, qbo_attachable_id = $2, posted_at = $3,
                review_status = 'approved', reviewed_at = NOW(), updated_at = NOW()
          WHERE id = $4`,
        [posting.qbo_bill_id, posting.qbo_attachable_id, posting.posted_at, heir.id]
      );
      inherited = { documentId: heir.id, docNumber: heir.doc_number, billId: posting.qbo_bill_id };
    }
    // No heir is survivable rather than a failure: posting any child whose
    // number matches an existing bill adopts it (findExistingBill in
    // ap-qbo-bills), so the worst case is one bill the reviewer approves again
    // and QBO does not duplicate. Reported so it is not a surprise.
  }

  return {
    ok: true,
    split: true,
    documentId: Number(documentId),
    children: children.map((c) => ({
      id: c.id, doc_number: c.doc_number, total_cents: c.total_cents,
      pages: c.page_from ? `${c.page_from}-${c.page_to}` : null,
    })),
    inherited,
    orphanedBillId: posting.qbo_bill_id && !inherited ? posting.qbo_bill_id : null,
  };
}

async function restorePosting(documentId, posting, opts = {}) {
  const hadPosting = posting.qbo_bill_id || posting.posted_at;
  if (!hadPosting && !opts.restoreExtract) return;

  const sets = [];
  const params = [];
  if (hadPosting) {
    params.push(posting.qbo_bill_id, posting.qbo_attachable_id, posting.posted_at);
    sets.push('qbo_bill_id = $1', 'qbo_attachable_id = $2', 'posted_at = $3');
  }
  if (opts.restoreExtract) {
    params.push(posting.extract_status, posting.extract_error);
    sets.push(`extract_status = $${params.length - 1}`, `extract_error = $${params.length}`);
  }
  params.push(documentId);
  await query(
    `UPDATE ap_documents SET ${sets.join(', ')}, updated_at = NOW() WHERE id = $${params.length}`,
    params
  );
}

module.exports = { rereadAsBundle };
