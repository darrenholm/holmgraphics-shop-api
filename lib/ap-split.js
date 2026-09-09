// lib/ap-split.js
// Cuts a PDF holding several invoices into one PDF per invoice.
//
// Suppliers send month-end reprints as a single file: Timbremart's August
// invoices arrive as one PDF of a dozen separate bills. Read as one document
// that is eleven bills silently lost, which is the worst failure this pipeline
// has — the money is owed either way, and nothing downstream ever asks where
// the rest went.
//
// The page ranges come from the extraction pass (document_pages), which has
// already read the file; this module only does the cutting. Every range is
// checked against the real page count before anything is written, because a
// range that runs off the end of the file would otherwise produce an empty
// PDF that looks like a valid bill with no pages.

'use strict';

const { PDFDocument } = require('pdf-lib');

async function pageCount(buffer) {
  const pdf = await PDFDocument.load(buffer, { ignoreEncryption: true });
  return pdf.getPageCount();
}

/**
 * @param {Buffer}   buffer  the bundle
 * @param {object[]} ranges  [{ doc_number, first_page, last_page }], 1-based inclusive
 * @returns {Promise<object[]>} [{ doc_number, first_page, last_page, buffer }]
 */
async function splitByRanges(buffer, ranges) {
  if (!Array.isArray(ranges) || ranges.length < 2) return [];

  const source = await PDFDocument.load(buffer, { ignoreEncryption: true });
  const total = source.getPageCount();

  // All or nothing. A partial split leaves some invoices as documents and the
  // rest inside a bundle nobody looks at again, which is harder to notice than
  // not splitting at all.
  for (const r of ranges) {
    if (r.first_page < 1 || r.last_page > total || r.last_page < r.first_page) {
      throw new Error(
        `Split range ${r.first_page}-${r.last_page} does not fit a ${total}-page file`
      );
    }
  }

  const out = [];
  for (const r of ranges) {
    const part = await PDFDocument.create();
    // copyPages takes 0-based indices; the ranges are 1-based and inclusive.
    const indices = [];
    for (let p = r.first_page; p <= r.last_page; p++) indices.push(p - 1);

    const copied = await part.copyPages(source, indices);
    for (const page of copied) part.addPage(page);

    out.push({
      doc_number:  r.doc_number || null,
      first_page:  r.first_page,
      last_page:   r.last_page,
      buffer:      Buffer.from(await part.save()),
    });
  }
  return out;
}

/** "invoices-august.pdf" + range → "invoices-august (8981197).pdf". */
function partFilename(originalFilename, range, index) {
  const base = String(originalFilename || 'document.pdf').replace(/\.pdf$/i, '');
  const label = range.doc_number
    ? String(range.doc_number).trim()
    : `pages ${range.first_page}-${range.last_page}`;
  return `${base} (${label || index + 1}).pdf`;
}

module.exports = { pageCount, splitByRanges, partFilename };
