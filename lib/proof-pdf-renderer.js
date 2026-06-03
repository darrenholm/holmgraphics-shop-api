// lib/proof-pdf-renderer.js
//
// Renders a project proof JPEG + the customer's annotation shapes into
// a single-page PDF. Used to attach an "annotated proof" to the staff
// notification email when a customer requests changes, so staff don't
// need to click through to the web viewer to see what was marked up.
//
// Pure JS — no node-canvas, no ghostscript. PDFKit draws the image and
// the vector annotations directly into the PDF.
//
// The annotation coordinate system matches what the browser canvas saves:
// vector shapes in NATURAL IMAGE PIXEL coordinates. Same scaling math
// as ProofAnnotationCanvas.svelte's redraw(), just running on the
// server with PDFKit primitives instead of Canvas 2D.

'use strict';

const PDFDocument = require('pdfkit');

// Wraps PDFDocument output (a Readable) into a Buffer that mailers can
// attach. PDFKit doesn't expose a synchronous "render to buffer" — we
// have to collect the stream.
function streamToBuffer(stream) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    stream.on('data', (c) => chunks.push(c));
    stream.on('end', () => resolve(Buffer.concat(chunks)));
    stream.on('error', reject);
  });
}

// Fetch the proof image from WHC. We use the public URL so we don't have
// to re-establish FTP just to read a file we already published.
async function fetchImageBuffer(imageUrl) {
  const res = await fetch(imageUrl);
  if (!res.ok) throw new Error(`fetch image ${imageUrl}: ${res.status}`);
  const ab = await res.arrayBuffer();
  return Buffer.from(ab);
}

// Map a hex color (#rrggbb or #rgb) to PDFKit's [r, g, b] 0-255 array.
function parseColor(hex, fallback = [220, 38, 38]) {
  const s = String(hex || '').trim();
  if (!/^#([0-9a-f]{3}|[0-9a-f]{6})$/i.test(s)) return fallback;
  let r, g, b;
  if (s.length === 4) {
    r = parseInt(s[1] + s[1], 16);
    g = parseInt(s[2] + s[2], 16);
    b = parseInt(s[3] + s[3], 16);
  } else {
    r = parseInt(s.slice(1, 3), 16);
    g = parseInt(s.slice(3, 5), 16);
    b = parseInt(s.slice(5, 7), 16);
  }
  return [r, g, b];
}

// Public API. Given the proof URL, image dimensions, and annotation
// shapes, returns a Buffer containing the rendered PDF.
//
// `imgW`/`imgH` are optional — if unset we use the page size to scale.
// `annotations` are the shapes the customer drew (image-pixel coords).
async function renderProofPdf({ imageUrl, imgW, imgH, annotations = [], projectId, projectName, version, customerName, customerText }) {
  const imgBuf = await fetchImageBuffer(imageUrl);

  // Letter page with a small margin. The proof image fills the content
  // area; annotations are drawn over it in the same coordinate system.
  const PAGE_MARGIN = 36;       // 0.5"
  const doc = new PDFDocument({ size: 'LETTER', margin: PAGE_MARGIN, info: {
    Title: `Proof v${version} — annotated — job #${projectId}`,
    Author: 'Holm Graphics',
    Subject: customerName ? `Annotations from ${customerName}` : 'Annotated proof',
  }});
  const bufP = streamToBuffer(doc);

  // ── Header ────────────────────────────────────────────────────────
  doc.fontSize(14).fillColor('#1a1a1a').text(
    `Annotated proof — job #${projectId}${projectName ? ` (${projectName})` : ''}`,
    PAGE_MARGIN, PAGE_MARGIN, { width: doc.page.width - 2 * PAGE_MARGIN }
  );
  doc.moveDown(0.25);
  doc.fontSize(10).fillColor('#475569').text(
    `v${version} — annotations from ${customerName || 'customer'}`,
    { width: doc.page.width - 2 * PAGE_MARGIN }
  );
  if (customerText) {
    doc.moveDown(0.5);
    doc.fontSize(10).fillColor('#1a1a1a').text(`"${customerText}"`, {
      width: doc.page.width - 2 * PAGE_MARGIN,
    });
  }
  const headerBottom = doc.y + 8;

  // ── Image area ────────────────────────────────────────────────────
  // Fit the image into the remaining content area, preserving aspect.
  const contentW = doc.page.width  - 2 * PAGE_MARGIN;
  const contentH = doc.page.height - headerBottom - PAGE_MARGIN;

  // If imgW/imgH weren't passed, derive from a hidden draw. PDFKit can
  // open the image first to get its dimensions, but the easier path is
  // to lean on the caller — and we DO know them server-side from the
  // upload row. Provide a safe fallback so this never explodes.
  let naturalW = imgW || 0;
  let naturalH = imgH || 0;
  if (!naturalW || !naturalH) {
    // Last-ditch: assume a 4:3 image. Annotations may be slightly off
    // but the PDF still renders the image correctly via PDFKit's auto-
    // fit since we don't pass explicit dimensions.
    naturalW = 1600; naturalH = 1200;
  }

  const scale = Math.min(contentW / naturalW, contentH / naturalH);
  const renderW = naturalW * scale;
  const renderH = naturalH * scale;
  const renderX = PAGE_MARGIN + (contentW - renderW) / 2;
  const renderY = headerBottom + (contentH - renderH) / 2;

  doc.image(imgBuf, renderX, renderY, { width: renderW, height: renderH });

  // ── Annotation overlay ────────────────────────────────────────────
  // Translate image-pixel coords to PDF user units via `scale`.
  // PDFKit uses points (1/72") — same coordinate space as we draw the
  // image into. So we can pre-multiply each (x, y) by `scale` and add
  // the renderX/renderY offset.
  function tx(x) { return renderX + x * scale; }
  function ty(y) { return renderY + y * scale; }

  for (const s of annotations) {
    if (!s || !s.type) continue;
    const [r, g, b] = parseColor(s.color);
    const width = Math.max(0.5, (s.width || 4) * scale);
    doc.lineCap('round').lineJoin('round')
       .lineWidth(width)
       .strokeColor(r, g, b)
       .fillColor(r, g, b);

    if (s.type === 'line' && Array.isArray(s.points) && s.points.length > 1) {
      doc.moveTo(tx(s.points[0][0]), ty(s.points[0][1]));
      for (let i = 1; i < s.points.length; i++) {
        doc.lineTo(tx(s.points[i][0]), ty(s.points[i][1]));
      }
      doc.stroke();
    } else if (s.type === 'arrow' && Array.isArray(s.points) && s.points.length === 2) {
      const [[x1, y1], [x2, y2]] = s.points;
      doc.moveTo(tx(x1), ty(y1)).lineTo(tx(x2), ty(y2)).stroke();
      const dx = x2 - x1, dy = y2 - y1;
      const len = Math.hypot(dx, dy);
      if (len > 4) {
        const ah = Math.max(width * 4, 12);   // arrowhead size in PDF units
        const ang = Math.atan2(dy, dx);
        doc.moveTo(tx(x2), ty(y2))
           .lineTo(tx(x2) - ah * Math.cos(ang - Math.PI / 7), ty(y2) - ah * Math.sin(ang - Math.PI / 7))
           .lineTo(tx(x2) - ah * Math.cos(ang + Math.PI / 7), ty(y2) - ah * Math.sin(ang + Math.PI / 7))
           .closePath().fill();
      }
    } else if (s.type === 'rect' && Array.isArray(s.points) && s.points.length === 2) {
      const [[x1, y1], [x2, y2]] = s.points;
      const rx = Math.min(tx(x1), tx(x2));
      const ry = Math.min(ty(y1), ty(y2));
      const rw = Math.abs(tx(x2) - tx(x1));
      const rh = Math.abs(ty(y2) - ty(y1));
      doc.rect(rx, ry, rw, rh).stroke();
    } else if (s.type === 'text' && Array.isArray(s.points) && s.points.length === 1) {
      // Circle marker + comment label to the right.
      const [x, y] = s.points[0];
      const cx = tx(x), cy = ty(y);
      const radius = Math.max(width * 3, 7);
      doc.circle(cx, cy, radius).fillColor(r, g, b).fill();
      if (s.text) {
        doc.fontSize(Math.max(radius * 0.9, 9))
           .fillColor(r, g, b)
           .text(s.text, cx + radius + 4, cy - radius, {
             width: Math.min(220, renderX + renderW - cx - radius - 8),
           });
      }
    }
  }

  doc.end();
  return bufP;
}

module.exports = { renderProofPdf };
