// lib/vin.js
// Server-side VIN validation — identical algorithm to the shop's
// src/lib/utils/vin.js. Both files must stay in sync. The check-digit
// rule comes from ISO 3779 / FMVSS 115 and is what every OEM, DMV, and
// telematics provider (including Smartcar) uses to gate vehicle linkage.

'use strict';

const TRANSLIT = {
  A: 1, B: 2, C: 3, D: 4, E: 5, F: 6, G: 7, H: 8,
  J: 1, K: 2, L: 3, M: 4, N: 5, P: 7, R: 9,
  S: 2, T: 3, U: 4, V: 5, W: 6, X: 7, Y: 8, Z: 9,
  0: 0, 1: 1, 2: 2, 3: 3, 4: 4, 5: 5, 6: 6, 7: 7, 8: 8, 9: 9
};

const WEIGHTS = [8, 7, 6, 5, 4, 3, 2, 10, 0, 9, 8, 7, 6, 5, 4, 3, 2];

function validateVin(vinRaw) {
  if (!vinRaw) return { valid: false, reason: 'VIN is empty.' };
  const vin = String(vinRaw).toUpperCase().trim();
  if (vin.length !== 17) return { valid: false, reason: `VIN must be exactly 17 characters (this has ${vin.length}).` };
  if (/[IOQ]/.test(vin)) return { valid: false, reason: 'VIN cannot contain I, O, or Q.' };
  if (!/^[A-HJ-NPR-Z0-9]{17}$/.test(vin)) return { valid: false, reason: 'VIN contains invalid characters.' };

  let sum = 0;
  for (let i = 0; i < 17; i++) {
    const v = TRANSLIT[vin[i]];
    if (v == null) return { valid: false, reason: `Invalid character "${vin[i]}" at position ${i + 1}.` };
    sum += v * WEIGHTS[i];
  }
  const remainder = sum % 11;
  const expectedCheckChar = remainder === 10 ? 'X' : String(remainder);
  if (expectedCheckChar !== vin[8]) {
    return { valid: false, reason: `VIN check digit at position 9 is "${vin[8]}"; expected "${expectedCheckChar}".` };
  }
  return { valid: true };
}

function normalizeVin(s) {
  return s ? String(s).toUpperCase().trim() : s;
}

module.exports = { validateVin, normalizeVin };
