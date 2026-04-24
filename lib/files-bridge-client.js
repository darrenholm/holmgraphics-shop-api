// lib/files-bridge-client.js
// API → files-bridge HTTP client. Lets the API push customer-uploaded
// artwork into the standard L:\ClientFiles[A-K|L-Z]\<Client>\Job<num>\
// folder structure without the API itself needing direct SMB access to
// the Buffalo NAS.
//
// Required env vars:
//   FILES_BRIDGE_URL         e.g. http://10.10.1.24:41961
//   FILES_BRIDGE_API_KEY     same value as files-bridge/.env API_KEY
//
// All operations are idempotent at the bridge level (folder creation
// uses mkdir -p semantics, file uploads overwrite by name).

'use strict';

const FILES_BRIDGE_URL    = process.env.FILES_BRIDGE_URL    || '';
const FILES_BRIDGE_API_KEY = process.env.FILES_BRIDGE_API_KEY || '';

function authHeaders() {
  if (!FILES_BRIDGE_URL || !FILES_BRIDGE_API_KEY) {
    throw new Error('Files-bridge not configured: set FILES_BRIDGE_URL and FILES_BRIDGE_API_KEY');
  }
  return { Authorization: `Bearer ${FILES_BRIDGE_API_KEY}` };
}

// ─── Resolve / create job folder ─────────────────────────────────────────────
// POST /clients/:name/jobs/:jobNo/ensure
async function ensureJobFolder(clientName, jobNo) {
  const url = `${FILES_BRIDGE_URL}/clients/${encodeURIComponent(clientName)}/jobs/${encodeURIComponent(jobNo)}/ensure`;
  const res = await fetch(url, { method: 'POST', headers: authHeaders() });
  const text = await res.text();
  let parsed;
  try { parsed = JSON.parse(text); } catch { parsed = text; }
  if (!res.ok) throw new Error(`files-bridge ensure ${res.status}: ${typeof parsed === 'string' ? parsed : JSON.stringify(parsed)}`);
  return parsed;
}

// ─── Upload a file ───────────────────────────────────────────────────────────
// POST /clients/:name/jobs/:jobNo/upload?subfolder=designs|proofs|shipping&as=<filename>
//
// fileBuffer  Buffer
// fileName    desired filename on disk (already sanitized by caller)
// mimeType    optional, defaults to 'application/octet-stream'
async function uploadFile({ clientName, jobNo, subfolder = 'designs', fileName, fileBuffer, mimeType = 'application/octet-stream' }) {
  const url = `${FILES_BRIDGE_URL}/clients/${encodeURIComponent(clientName)}/jobs/${encodeURIComponent(jobNo)}/upload?subfolder=${encodeURIComponent(subfolder)}&as=${encodeURIComponent(fileName)}`;

  // Build a minimal multipart body manually — Node's `fetch` doesn't accept
  // a FormData with Buffer directly without the `formdata-node` polyfill,
  // so do it the old way.
  const boundary = `----HG${Date.now().toString(36)}`;
  const head = Buffer.from(
    `--${boundary}\r\n` +
    `Content-Disposition: form-data; name="file"; filename="${fileName.replace(/"/g, '')}"\r\n` +
    `Content-Type: ${mimeType}\r\n\r\n`,
    'utf8'
  );
  const tail = Buffer.from(`\r\n--${boundary}--\r\n`, 'utf8');
  const body = Buffer.concat([head, fileBuffer, tail]);

  const res = await fetch(url, {
    method: 'POST',
    headers: {
      ...authHeaders(),
      'Content-Type':   `multipart/form-data; boundary=${boundary}`,
      'Content-Length': String(body.length),
    },
    body,
  });
  const text = await res.text();
  let parsed;
  try { parsed = JSON.parse(text); } catch { parsed = text; }
  if (!res.ok) throw new Error(`files-bridge upload ${res.status}: ${typeof parsed === 'string' ? parsed : JSON.stringify(parsed)}`);
  return parsed;
}

// ─── Health check ────────────────────────────────────────────────────────────
async function health() {
  const res = await fetch(`${FILES_BRIDGE_URL}/health`);
  if (!res.ok) throw new Error(`files-bridge health ${res.status}`);
  return res.json();
}

module.exports = { ensureJobFolder, uploadFile, health };
