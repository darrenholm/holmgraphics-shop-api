// lib/encryption.js
// AES-256-GCM symmetric encryption for secrets that must travel through
// the DB (Smartcar OAuth tokens, etc.). GCM gives authenticated encryption
// — tampered ciphertext fails decryption rather than silently returning
// garbage, which is what we want for credentials.
//
// Key handling:
//   ENCRYPTION_KEY env var must be a 32-byte key encoded as 64-char hex OR
//   44-char base64. We accept either form. If the env var is missing in
//   production, encrypt() / decrypt() throw — callers should catch and
//   surface "telematics not configured" rather than fall back to plaintext.
//
// Wire format (single string for one-column storage):
//   <iv-hex>:<auth-tag-hex>:<ciphertext-hex>
//   IV is 12 random bytes (GCM recommended size)
//   auth tag is the GCM tag, 16 bytes
//   plaintext is UTF-8

'use strict';

const crypto = require('crypto');

const ALG = 'aes-256-gcm';
const IV_BYTES = 12;
const KEY_BYTES = 32;

function loadKey() {
  const raw = process.env.ENCRYPTION_KEY;
  if (!raw) {
    const e = new Error(
      'ENCRYPTION_KEY env var is not set. Generate one with: ' +
      '`node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'hex\'))"`'
    );
    e.code = 'ENCRYPTION_KEY_MISSING';
    throw e;
  }
  let key;
  if (/^[0-9a-f]{64}$/i.test(raw)) {
    key = Buffer.from(raw, 'hex');
  } else {
    try { key = Buffer.from(raw, 'base64'); } catch { key = null; }
  }
  if (!key || key.length !== KEY_BYTES) {
    const e = new Error(`ENCRYPTION_KEY must decode to ${KEY_BYTES} bytes (got ${key?.length || 0}). Use 64-char hex or 44-char base64.`);
    e.code = 'ENCRYPTION_KEY_BAD';
    throw e;
  }
  return key;
}

function encrypt(plaintext) {
  if (plaintext == null) return null;
  const key = loadKey();
  const iv  = crypto.randomBytes(IV_BYTES);
  const cipher = crypto.createCipheriv(ALG, key, iv);
  const ct = Buffer.concat([cipher.update(String(plaintext), 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [iv.toString('hex'), tag.toString('hex'), ct.toString('hex')].join(':');
}

function decrypt(payload) {
  if (payload == null) return null;
  const parts = String(payload).split(':');
  if (parts.length !== 3) {
    const e = new Error('decrypt: malformed payload (expected iv:tag:ciphertext)');
    e.code = 'ENCRYPTION_PAYLOAD_MALFORMED';
    throw e;
  }
  const [ivHex, tagHex, ctHex] = parts;
  const key = loadKey();
  const iv = Buffer.from(ivHex, 'hex');
  const tag = Buffer.from(tagHex, 'hex');
  const ct = Buffer.from(ctHex, 'hex');
  const decipher = crypto.createDecipheriv(ALG, key, iv);
  decipher.setAuthTag(tag);
  const pt = Buffer.concat([decipher.update(ct), decipher.final()]);
  return pt.toString('utf8');
}

// True iff the key is set + decodes cleanly. Routes that need encryption
// can short-circuit with a 503 when this is false instead of throwing
// mid-request.
function isConfigured() {
  try { loadKey(); return true; } catch { return false; }
}

module.exports = { encrypt, decrypt, isConfigured };
