// lib/proof-compose.js
//
// Turns the files staff picked for one proof (JPEG / PNG / WebP / PDF, one
// or several) into the single raster image the proof flow runs on. A job
// often has more than one piece to sign off (e.g. a sign AND a window etch),
// and the customer page, email preview, annotation canvas and markup PDF all
// work on one image — so several files are stacked top to bottom into one
// tall image rather than teaching every one of those about multiple pages.
//
//   one image          -> passed through untouched (same as before)
//   one 1-page PDF     -> page rasterized to PNG (same as before)
//   anything else      -> every page of every file, stacked, as a JPEG
//
// Stacking uses @napi-rs/canvas, which pdf-to-img/pdfjs already pulls in.
// It is required lazily: if it isn't there, a multi-file proof fails with a
// clear message instead of taking the whole upload route down.

'use strict';

const { rasterizePdfPages } = require('./proof-pdf-rasterize');

const MAX_PAGES = 8;        // total across all files
const TARGET_W  = 2400;     // stacked image width, px
const GAP       = 60;       // white space between pieces, px
const MAX_H     = 16000;    // keep well inside browser/canvas limits

let canvasLib = null;
function loadCanvas() {
  if (!canvasLib) canvasLib = require('@napi-rs/canvas');
  return canvasLib;
}

function isPdf(f) { return /^application\/pdf$/i.test(f.mimetype || ''); }

// files: multer file objects ({ buffer, mimetype, originalname }).
// Returns { buffer, mime, pages } — pages = how many pieces went in.
async function composeProof(files) {
  if (!files || !files.length) throw new Error('no files');

  // Single image: leave it exactly as uploaded.
  if (files.length === 1 && !isPdf(files[0])) {
    return { buffer: files[0].buffer, mime: files[0].mimetype, pages: 1 };
  }

  // Collect page rasters in order.
  const pages = [];
  for (const f of files) {
    if (pages.length >= MAX_PAGES) break;
    if (isPdf(f)) {
      const got = await rasterizePdfPages(f.buffer, MAX_PAGES - pages.length);
      if (!got.length) throw new Error(`Couldn't read the PDF "${f.originalname}".`);
      for (const p of got) pages.push({ buffer: p, name: f.originalname });
    } else {
      pages.push({ buffer: f.buffer, name: f.originalname });
    }
  }

  // One PDF with one page: keep the old behaviour (plain PNG of the page).
  if (pages.length === 1) {
    return { buffer: pages[0].buffer, mime: 'image/png', pages: 1 };
  }

  let lib;
  try { lib = loadCanvas(); } catch (e) {
    throw new Error('Sending several files as one proof needs @napi-rs/canvas on the server: ' + e.message);
  }
  const imgs = [];
  for (const p of pages) imgs.push(await lib.loadImage(p.buffer));

  // Scale every piece to one width so they line up.
  const w = Math.min(TARGET_W, Math.max(...imgs.map((i) => i.width)));
  let heights = imgs.map((i) => Math.round(i.height * (w / i.width)));
  let total = heights.reduce((a, b) => a + b, 0) + GAP * (imgs.length + 1);
  let s = 1;
  if (total > MAX_H) {                           // very tall stack: shrink the lot
    s = MAX_H / total;
    heights = heights.map((h) => Math.round(h * s));
    total = Math.round(total * s);
  }
  const cw = Math.round(w * s) + Math.round(GAP * s) * 2;
  const gap = Math.round(GAP * s);

  const canvas = lib.createCanvas(cw, total);
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, cw, total);
  let y = gap;
  imgs.forEach((img, i) => {
    ctx.drawImage(img, gap, y, Math.round(w * s), heights[i]);
    y += heights[i] + gap;
  });

  const buffer = await canvas.encode('jpeg', 90);
  return { buffer, mime: 'image/jpeg', pages: imgs.length };
}

module.exports = { composeProof, MAX_PAGES };
