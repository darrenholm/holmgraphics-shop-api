// Splitting a bundle is the one operation here that can invent or destroy a
// bill outright, so the ranges are exercised against a real PDF rather than a
// stubbed one.

const test   = require('node:test');
const assert = require('node:assert/strict');
const { PDFDocument } = require('pdf-lib');

const { pageCount, splitByRanges, partFilename } = require('./ap-split');

async function makePdf(pages) {
  const pdf = await PDFDocument.create();
  for (let i = 0; i < pages; i++) pdf.addPage([612, 792]);
  return Buffer.from(await pdf.save());
}

test('splits a bundle into one PDF per invoice, pages intact', async () => {
  const bundle = await makePdf(5);
  const parts = await splitByRanges(bundle, [
    { doc_number: '8981197', first_page: 1, last_page: 2 },
    { doc_number: '8981198', first_page: 3, last_page: 5 },
  ]);

  assert.equal(parts.length, 2);
  assert.equal(await pageCount(parts[0].buffer), 2);
  assert.equal(await pageCount(parts[1].buffer), 3);
  assert.equal(parts[0].doc_number, '8981197');
});

test('every page of the bundle survives the split', async () => {
  const bundle = await makePdf(7);
  const parts = await splitByRanges(bundle, [
    { doc_number: 'A', first_page: 1, last_page: 1 },
    { doc_number: 'B', first_page: 2, last_page: 4 },
    { doc_number: 'C', first_page: 5, last_page: 7 },
  ]);

  const counts = await Promise.all(parts.map((p) => pageCount(p.buffer)));
  assert.equal(counts.reduce((a, b) => a + b, 0), 7);
});

test('a range running off the end of the file is refused outright', async () => {
  const bundle = await makePdf(3);
  await assert.rejects(
    () => splitByRanges(bundle, [
      { doc_number: 'A', first_page: 1, last_page: 2 },
      { doc_number: 'B', first_page: 3, last_page: 9 },
    ]),
    /does not fit a 3-page file/
  );
});

test('one range is not a bundle', async () => {
  const bundle = await makePdf(3);
  assert.deepEqual(await splitByRanges(bundle, [{ first_page: 1, last_page: 3 }]), []);
});

test('part filenames carry the invoice number', () => {
  assert.equal(
    partFilename('timbremart-august.pdf', { doc_number: '8981197', first_page: 1, last_page: 2 }, 0),
    'timbremart-august (8981197).pdf'
  );
  assert.equal(
    partFilename('scan.pdf', { doc_number: null, first_page: 3, last_page: 4 }, 1),
    'scan (pages 3-4).pdf'
  );
});

// The Timbremart failure: seven one-page invoices came back as three ranges
// covering four pages. Splitting on that produced three bills and dropped
// four — and the parent is marked done, so nothing downstream ever asks
// where they went.

test('ranges that stop short of the last page are refused', async () => {
  const bundle = await makePdf(7);
  await assert.rejects(
    () => splitByRanges(bundle, [
      { doc_number: 'A', first_page: 1, last_page: 2 },
      { doc_number: 'B', first_page: 3, last_page: 3 },
      { doc_number: 'C', first_page: 4, last_page: 4 },
    ]),
    /every page must belong to an invoice/
  );
});

test('ranges that start after page 1 are refused', async () => {
  const bundle = await makePdf(4);
  await assert.rejects(
    () => splitByRanges(bundle, [
      { doc_number: 'A', first_page: 2, last_page: 3 },
      { doc_number: 'B', first_page: 4, last_page: 4 },
    ]),
    /every page must belong to an invoice/
  );
});

test('a gap in the middle is refused', async () => {
  const bundle = await makePdf(5);
  await assert.rejects(
    () => splitByRanges(bundle, [
      { doc_number: 'A', first_page: 1, last_page: 2 },
      { doc_number: 'B', first_page: 4, last_page: 5 },
    ]),
    /leave a gap between pages 2 and 4/
  );
});

test('the real shape: seven one-page invoices', async () => {
  const bundle = await makePdf(7);
  const ranges = Array.from({ length: 7 }, (_, i) => ({
    doc_number: `2608-00556${i}`, first_page: i + 1, last_page: i + 1,
  }));
  const parts = await splitByRanges(bundle, ranges);

  assert.equal(parts.length, 7);
  for (const p of parts) assert.equal(await pageCount(p.buffer), 1);
});
