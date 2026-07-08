// lib/fleet-storage.js
// Backend-agnostic storage for fleet documents (registration / insurance /
// CVOR scans). All access is mediated by routes/fleet.js so files are NEVER
// served by URL — every fetch hits an authenticated, logged Express route
// that calls the helpers in this module to stream from disk.
//
// v1 uses the API container's local filesystem under FLEET_DOCS_DIR
// (default /data/fleet). On Railway, attach a persistent Volume at /data
// so files survive deploys; locally, point FLEET_DOCS_DIR at ./tmp/fleet
// or similar. The existing files-bridge service is upload-only with no
// download endpoint, so we don't reuse it here — when/if the bridge grows
// a download endpoint or we move to S3/R2, swap the implementations of
// the four exported functions below and nothing else changes.
//
// File-naming contract (per spec): {vehicle_id}/{doc_type}/{uuid}.{ext}.
// No original filename in the path — keeps the storage layer free of PII
// and means uploads aren't guessable by URL.

'use strict';

const fs   = require('fs');
const fsp  = require('fs/promises');
const path = require('path');
const crypto = require('crypto');

const FLEET_DOCS_DIR = process.env.FLEET_DOCS_DIR || '/data/fleet';

// Lock down the allowed extensions ↔ MIME pairs. Anything else is rejected
// at the route layer, but this map is the second line of defence and the
// source of truth for the file_mime CHECK constraint in 023_fleet_documents.
const MIME_TO_EXT = {
  'image/jpeg':       'jpg',
  'image/png':        'png',
  'application/pdf':  'pdf'
};
const ALLOWED_MIMES = Object.keys(MIME_TO_EXT);
const MAX_BYTES = 25 * 1024 * 1024;

function extForMime(mime) {
  return MIME_TO_EXT[mime] || null;
}

// Returns the absolute on-disk path for a stored doc. Used by the streaming
// endpoint to open + pipe the file. Joined safely so a malicious file_path
// from the DB can't escape FLEET_DOCS_DIR via "../" components.
function resolveAbsolutePath(filePath) {
  const root = path.resolve(FLEET_DOCS_DIR);
  const abs  = path.resolve(root, filePath);
  if (!abs.startsWith(root + path.sep) && abs !== root) {
    throw new Error('file_path escapes FLEET_DOCS_DIR');
  }
  return abs;
}

// Save a Buffer to {vehicle_id}/{doc_type}/{uuid}.{ext}. Returns the
// RELATIVE path (no FLEET_DOCS_DIR prefix) — that's what goes in the DB.
async function saveDocument({ vehicleId, docType, buffer, mime }) {
  if (!Buffer.isBuffer(buffer)) throw new Error('saveDocument: buffer required');
  if (buffer.length > MAX_BYTES) {
    const e = new Error(`File too large (${(buffer.length / 1024 / 1024).toFixed(1)} MB) — max is 25 MB.`);
    e.code = 'FILE_TOO_LARGE';
    throw e;
  }
  const ext = extForMime(mime);
  if (!ext) {
    const e = new Error(`Unsupported file type ${mime} — only JPG, PNG, and PDF are accepted.`);
    e.code = 'UNSUPPORTED_MIME';
    throw e;
  }
  const uuid = crypto.randomUUID();
  const relPath = path.join(String(vehicleId), docType, `${uuid}.${ext}`);
  const absPath = resolveAbsolutePath(relPath);
  await fsp.mkdir(path.dirname(absPath), { recursive: true });
  await fsp.writeFile(absPath, buffer);
  return {
    file_path:       relPath.split(path.sep).join('/'),  // store with forward slashes for portability
    file_size_bytes: buffer.length,
    file_mime:       mime
  };
}

// Open a read stream for the streaming endpoint. Throws if the file is
// missing — caller responds 404.
function streamDocument(filePath) {
  const abs = resolveAbsolutePath(filePath);
  return fs.createReadStream(abs);
}

// Stat the file (size, mtime). Used by the streaming endpoint to set
// Content-Length and decide whether to honour Range requests.
async function statDocument(filePath) {
  const abs = resolveAbsolutePath(filePath);
  return fsp.stat(abs);
}

// Save an operator-level document (e.g. CVOR) — same shape as
// saveDocument but the path lives under `_operator/{doc_type}/` since
// there's no vehicle_id. The leading underscore keeps it from colliding
// with any numeric vehicle directory.
async function saveOperatorDocument({ docType, buffer, mime }) {
  if (!Buffer.isBuffer(buffer)) throw new Error('saveOperatorDocument: buffer required');
  if (buffer.length > MAX_BYTES) {
    const e = new Error(`File too large (${(buffer.length / 1024 / 1024).toFixed(1)} MB) — max is 25 MB.`);
    e.code = 'FILE_TOO_LARGE';
    throw e;
  }
  const ext = extForMime(mime);
  if (!ext) {
    const e = new Error(`Unsupported file type ${mime} — only JPG, PNG, and PDF are accepted.`);
    e.code = 'UNSUPPORTED_MIME';
    throw e;
  }
  const uuid = crypto.randomUUID();
  const relPath = path.join('_operator', docType, `${uuid}.${ext}`);
  const absPath = resolveAbsolutePath(relPath);
  await fsp.mkdir(path.dirname(absPath), { recursive: true });
  await fsp.writeFile(absPath, buffer);
  return {
    file_path:       relPath.split(path.sep).join('/'),
    file_size_bytes: buffer.length,
    file_mime:       mime
  };
}

// Save a staff document (e.g. driver's license) — same shape as
// saveDocument but pathed under `_staff/{employee_id}/{doc_type}/`. The
// leading underscore keeps it from colliding with numeric vehicle dirs
// (same trick as _operator).
async function saveStaffDocument({ employeeId, docType, buffer, mime }) {
  if (!Buffer.isBuffer(buffer)) throw new Error('saveStaffDocument: buffer required');
  if (buffer.length > MAX_BYTES) {
    const e = new Error(`File too large (${(buffer.length / 1024 / 1024).toFixed(1)} MB) — max is 25 MB.`);
    e.code = 'FILE_TOO_LARGE';
    throw e;
  }
  const ext = extForMime(mime);
  if (!ext) {
    const e = new Error(`Unsupported file type ${mime} — only JPG, PNG, and PDF are accepted.`);
    e.code = 'UNSUPPORTED_MIME';
    throw e;
  }
  const uuid = crypto.randomUUID();
  const relPath = path.join('_staff', String(employeeId), docType, `${uuid}.${ext}`);
  const absPath = resolveAbsolutePath(relPath);
  await fsp.mkdir(path.dirname(absPath), { recursive: true });
  await fsp.writeFile(absPath, buffer);
  return {
    file_path:       relPath.split(path.sep).join('/'),
    file_size_bytes: buffer.length,
    file_mime:       mime
  };
}

// Best-effort delete. Returns true if removed, false if it didn't exist.
// Currently unused — docs are kept in the DB with is_current=false rather
// than hard-deleted — but exposed for future cleanup tools.
async function deleteDocument(filePath) {
  const abs = resolveAbsolutePath(filePath);
  try { await fsp.unlink(abs); return true; }
  catch (e) { if (e.code === 'ENOENT') return false; throw e; }
}

module.exports = {
  FLEET_DOCS_DIR,
  MAX_BYTES,
  ALLOWED_MIMES,
  extForMime,
  saveDocument,
  saveOperatorDocument,
  saveStaffDocument,
  streamDocument,
  statDocument,
  deleteDocument
};
