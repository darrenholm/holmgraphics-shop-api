// lib/slugify.js
//
// Convert a free-form text label into a filesystem-safe, lowercase,
// hyphen-separated slug. Used to build the human-readable artwork
// filenames in routes/designs.js (Job{N}-{position-slug}-{name-slug}.ext)
// and anywhere else we want a stable identifier derived from staff- or
// customer-supplied text.
//
// Behaviours, in order:
//   1. null / undefined / non-string  → return `fallback` (default '')
//   2. NFKD-normalise + strip combining marks so "Très" → "tres"
//   3. Lowercase, replace any run of non-[a-z0-9] with '-'
//   4. Collapse repeated hyphens, trim leading/trailing hyphens
//   5. If still empty (e.g. input was all punctuation), return `fallback`
//   6. If `maxLen` is set and the slug exceeds it, slice and re-trim
//      trailing hyphens so we never end on a separator

'use strict';

function slugify(input, { maxLen = Infinity, fallback = '' } = {}) {
  if (input == null || typeof input.toString !== 'function') return fallback;
  let s = String(input).trim();
  if (!s) return fallback;

  // Decompose accented characters into base + combining marks, then drop
  // the marks. Catches French, German umlauts, etc. — anything outside
  // basic Latin still gets stripped by step 3 below.
  s = s.normalize('NFKD').replace(/[̀-ͯ]/g, '');

  // Lowercase + non-alphanumeric → hyphen.
  s = s.toLowerCase().replace(/[^a-z0-9]+/g, '-');

  // Collapse + trim hyphens.
  s = s.replace(/-+/g, '-').replace(/^-+|-+$/g, '');

  if (!s) return fallback;

  if (s.length > maxLen) {
    s = s.slice(0, maxLen).replace(/-+$/, '');
    if (!s) return fallback;
  }

  return s;
}

module.exports = { slugify };
