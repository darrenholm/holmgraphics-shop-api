// lib/proof-pdf-rasterize.js
//
// Converts page 1 of a PDF proof into a JPEG buffer so the customer
// can see it inline in the approval email and the annotation canvas
// can overlay on a raster image. (PDFs don't render in <img> tags and
// the canvas overlay math assumes pixel coords on a flat raster.)
//
// Uses `pdf-to-img` which wraps pdfjs-dist + node-canvas. node-canvas
// needs cairo/pango/libjpeg on the host. We require() it lazily and
// swallow load errors so a misconfigured deploy keeps falling back to
// storing the PDF as-is instead of failing every proof upload.

'use strict';

let pdfToImg = null;
let loadError = null;

function loadConverter() {
  if (pdfToImg || loadError) return pdfToImg;
  try {
    // pdf-to-img v6+ exposes `pdf` (async iterable of pages) as default.
    // In CommonJS this lands on the .default property of the module.
    const mod = require('pdf-to-img');
    pdfToImg = mod.pdf || mod.default || mod;
  } catch (e) {
    loadError = e;
    console.warn('[proof-pdf-rasterize] pdf-to-img unavailable — PDFs will be stored as-is:', e.message);
  }
  return pdfToImg;
}

// Returns { buffer, mime, width, height } for page 1 of the PDF, or null
// if conversion isn't possible (lib not loaded, blank PDF, etc.). The
// caller is expected to fall back to storing the original file in that
// case so the proof flow keeps working — staff will just have a PDF
// proof that doesn't render an inline preview in the customer email.
async function rasterizePdfPageOne(pdfBuffer) {
  const pdf = loadConverter();
  if (!pdf) return null;
  try {
    // Scale=2 yields ~1700 px wide for a US Letter at 72 dpi, which is
    // enough resolution for screen review without bloating the WHC file.
    // pdf-to-img returns PNG bytes; we keep PNG here so transparency
    // survives — uploads are small enough (~500 KB) that compressing to
    // JPEG isn't worth the lossy round-trip on artwork.
    const doc = await pdf(pdfBuffer, { scale: 2 });
    for await (const pageBuffer of doc) {
      // First page only.
      return {
        buffer: pageBuffer,
        mime: 'image/png',
        // pdf-to-img doesn't expose dimensions on the iterator — we
        // leave width/height undefined; the PDF renderer for the
        // staff email uses an aspect-fit fallback when natural size
        // is unknown.
        width: null, height: null,
      };
    }
    return null;
  } catch (e) {
    console.warn('[proof-pdf-rasterize] rasterize failed:', e.message);
    return null;
  }
}

function isAvailable() {
  loadConverter();
  return Boolean(pdfToImg);
}

module.exports = { rasterizePdfPageOne, isAvailable };
