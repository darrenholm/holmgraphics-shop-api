// suppliers/sinalite/files.js
//
// Hosting for print-ready PDFs that SinaLite downloads when we place an
// order. Files live on the Railway volume (same /data mount as fleet docs)
// and are served publicly behind a random token — SinaLite's servers fetch
// them without logging in.
//
// Env:
//   SINALITE_FILES_DIR    default /data/sinalite
//   SINALITE_PUBLIC_BASE  default https://holmgraphics-shop-api-production.up.railway.app
//                         (the host SinaLite has to allow through its firewall)

'use strict';

const fsp = require('fs/promises');
const path = require('path');
const crypto = require('crypto');

const FILES_DIR = process.env.SINALITE_FILES_DIR || '/data/sinalite';
const PUBLIC_BASE = (process.env.SINALITE_PUBLIC_BASE ||
  'https://holmgraphics-shop-api-production.up.railway.app').replace(/\/+$/, '');

// Print PDFs get big (large format especially). Multer writes to disk, so
// this doesn't sit in memory.
const MAX_BYTES = 500 * 1024 * 1024;

const TOKEN_RE = /^[a-f0-9]{32}$/;

function newToken() {
  return crypto.randomBytes(16).toString('hex');
}

// Keep the client's file name readable in the URL but URL-safe:
// "Smith Cards FRONT.pdf" → "Smith-Cards-FRONT.pdf".
function safeName(name) {
  const base = path.basename(String(name || 'file.pdf')).replace(/\.pdf$/i, '');
  const clean = base.replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 80);
  return `${clean || 'file'}.pdf`;
}

function relPathFor(token) {
  return `${token.slice(0, 2)}/${token}.pdf`;
}

function absPath(relPath) {
  const root = path.resolve(FILES_DIR);
  const abs = path.resolve(root, relPath);
  if (!abs.startsWith(root + path.sep)) throw new Error('file path escapes SINALITE_FILES_DIR');
  return abs;
}

function publicUrl(token, name) {
  return `${PUBLIC_BASE}/api/sinalite/files/${token}/${encodeURIComponent(safeName(name))}`;
}

// Real PDFs start with "%PDF-" (a few bytes of junk before it is tolerated
// by readers, so look in the first 1 KB). Guards against a renamed JPG
// going to the printer.
function looksLikePdf(buf) {
  return Buffer.isBuffer(buf) && buf.subarray(0, 1024).includes(Buffer.from('%PDF-'));
}

// Move an uploaded temp file into its permanent spot.
async function storeUpload(tmpPath, token) {
  const rel = relPathFor(token);
  const dest = absPath(rel);
  await fsp.mkdir(path.dirname(dest), { recursive: true });
  try {
    await fsp.rename(tmpPath, dest);
  } catch (e) {
    if (e.code !== 'EXDEV') throw e;
    await fsp.copyFile(tmpPath, dest);
    await fsp.unlink(tmpPath);
  }
  return rel;
}

// The webhook URL carries a secret so random POSTs can't fake shipments
// (SinaLite doesn't sign its webhooks). Use SINALITE_WEBHOOK_SECRET if set,
// otherwise derive a stable one from the client secret so no extra
// Railway variable is needed.
function webhookSecret() {
  if (process.env.SINALITE_WEBHOOK_SECRET) return process.env.SINALITE_WEBHOOK_SECRET;
  const cs = process.env.SINALITE_CLIENT_SECRET;
  if (!cs) return null;
  return crypto.createHmac('sha256', cs).update('holmgraphics-sinalite-webhook').digest('hex').slice(0, 32);
}

function webhookUrl() {
  const s = webhookSecret();
  return s ? `${PUBLIC_BASE}/api/sinalite/webhook/${s}` : null;
}

function secretMatches(given) {
  const want = webhookSecret();
  if (!want || typeof given !== 'string' || given.length !== want.length) return false;
  return crypto.timingSafeEqual(Buffer.from(given), Buffer.from(want));
}

module.exports = {
  FILES_DIR,
  PUBLIC_BASE,
  MAX_BYTES,
  TOKEN_RE,
  newToken,
  safeName,
  absPath,
  publicUrl,
  looksLikePdf,
  storeUpload,
  webhookUrl,
  secretMatches,
};
