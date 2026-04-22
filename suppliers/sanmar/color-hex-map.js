// suppliers/sanmar/color-hex-map.js
//
// SanMar Canada doesn't expose colour hex codes on any of its APIs:
//   - Bulk Data 1.0     returns `swatchColor` as a name only.
//   - Product Data 2.0  returns a single DEFAULT part with hex="NA".
//   - Media Content 1.2 returns `color` as a name, no hex field in schema.
//
// The storefront needs real dots, though, so we keep a hand-curated map
// keyed on the lowercased colour name we receive in `swatchColor`. Match
// is case-insensitive and trimmed; anything unmatched leaves color_hex
// NULL and the UI falls back to a grey circle.
//
// Coverage goal: every colour currently in supplier_variant should hit.
// Run `SELECT DISTINCT color_name FROM supplier_variant WHERE color_hex IS
// NULL ORDER BY color_name` after each ingest to find gaps — add rows to
// MAP, redeploy, hit POST /api/suppliers/sanmar/apply-color-hex to backfill.
//
// Keep keys lowercase, no punctuation variation beyond what SanMar sends.
// If SanMar changes a name (e.g. "Athletic Heather" → "Athletic Hthr") the
// old key can stay — it just won't match new rows.

const MAP = {
  // ── neutrals ────────────────────────────────────────────────────────
  'black':                 '#000000',
  'jet black':             '#0A0A0A',
  'true black':            '#000000',
  'white':                 '#FFFFFF',
  'off white':             '#F8F4E9',
  'natural':               '#E8DDBC',
  'ivory':                 '#FFFFF0',
  'cream':                 '#F5F0E1',
  'bone':                  '#E3DAC9',
  'khaki':                 '#B7A98B',
  'stone':                 '#8F826B',
  'sand':                  '#C2B280',
  'tan':                   '#AD9968',
  'beige':                 '#D9C29A',
  'camel':                 '#C19A6B',
  'coyote':                '#81613C',
  'brown':                 '#5C3A21',
  'dark chocolate':        '#3A2416',
  'chocolate':             '#4A2C1A',
  'espresso':              '#3C2A21',
  'mocha':                 '#7A5A3D',

  // ── greys ───────────────────────────────────────────────────────────
  'grey':                  '#808080',
  'gray':                  '#808080',
  'dark grey':             '#4A4A4A',
  'dark gray':             '#4A4A4A',
  'light grey':            '#B6B6B6',
  'light gray':            '#B6B6B6',
  'athletic heather':      '#A7A9AC',
  'heather grey':          '#A7A9AC',
  'heather gray':          '#A7A9AC',
  'sport grey':            '#9EA2A2',
  'sport gray':            '#9EA2A2',
  'ash':                   '#B2BEB5',
  'ash grey':              '#B2BEB5',
  'silver':                '#C0C0C0',
  'fog':                   '#BFC1C2',
  'smoke':                 '#848482',
  'steel':                 '#6D7278',
  'steel grey':            '#6D7278',
  'charcoal':              '#36454F',
  'charcoal heather':      '#4C5257',
  'dark heather':          '#4A4A4A',
  'graphite':              '#383E42',
  'graphite heather':      '#474B4E',
  'gravel':                '#707070',
  'coal':                  '#2B2B2B',
  'iron grey':              '#484A51',
  'iron gray':             '#484A51',

  // ── reds / pinks ────────────────────────────────────────────────────
  'red':                   '#D52B1E',
  'true red':              '#D52B1E',
  'classic red':           '#B11F24',
  'cardinal':              '#9E1B32',
  'cardinal red':          '#9E1B32',
  'deep red':              '#7B1113',
  'brick':                 '#B22222',
  'rust':                  '#B7410E',
  'burgundy':              '#800020',
  'maroon':                '#7C1F2C',
  'wine':                  '#722F37',
  'cherry':                '#CC2936',
  'heather red':           '#C04953',
  'pink':                  '#FF80AB',
  'light pink':            '#F4C2C2',
  'hot pink':              '#FF1493',
  'raspberry':             '#B3446C',
  'fuchsia':               '#C154C1',
  'coral':                 '#FF7F50',
  'salmon':                '#FA8072',
  'flamingo':              '#FC8EAC',
  'neon pink':             '#FF6EC7',

  // ── oranges / yellows ───────────────────────────────────────────────
  'orange':                '#E87722',
  'texas orange':          '#BF5700',
  'deep orange':           '#C04000',
  'burnt orange':          '#CC5500',
  'safety orange':         '#FF6600',
  'neon orange':           '#FF8C00',
  'mustard':               '#E1AD01',
  'gold':                  '#D4AF37',
  'old gold':              '#B39700',
  'vegas gold':            '#C5B358',
  'yellow':                '#FFD100',
  'athletic gold':         '#FFB81C',
  'maize':                 '#FFCC00',
  'bright yellow':         '#FFE600',
  'safety yellow':         '#F5E400',
  'neon yellow':           '#DFFF00',

  // ── greens ──────────────────────────────────────────────────────────
  'green':                 '#2E7D32',
  'kelly green':           '#4CBB17',
  'kelly':                 '#4CBB17',
  'hunter green':          '#355E3B',
  'hunter':                '#355E3B',
  'forest green':          '#228B22',
  'forest':                '#228B22',
  'lime':                  '#C0E200',
  'neon green':            '#39FF14',
  'safety green':          '#C7E400',
  'olive':                 '#708238',
  'olive drab':            '#6B8E23',
  'loden':                 '#4C5D3A',
  'military green':        '#4B5320',
  'army':                  '#4B5320',
  'army green':            '#4B5320',
  'dark green':            '#1E4D2B',
  'sage':                  '#9CAF88',
  'mint':                  '#B8E0D2',
  'teal':                  '#008080',
  'dark teal':             '#014D4E',
  'emerald':               '#046307',
  'heather forest':        '#3F6B48',
  'heather kelly':         '#6CAF5F',
  'heather military':      '#5C6D3E',

  // ── blues ───────────────────────────────────────────────────────────
  'blue':                  '#0F4C81',
  'royal':                 '#1D3FA5',
  'royal blue':            '#1D3FA5',
  'true royal':            '#1D3FA5',
  'deep royal':            '#162D6A',
  'navy':                  '#1B1F3A',
  'true navy':             '#1B1F3A',
  'classic navy':          '#1B1F3A',
  'dark navy':             '#0F1330',
  'light blue':            '#ADD8E6',
  'sky blue':              '#87CEEB',
  'columbia blue':         '#9BCBEB',
  'carolina blue':         '#4B9CD3',
  'light royal':           '#4169E1',
  'turquoise':             '#30D5C8',
  'aqua':                  '#00FFFF',
  'caribbean blue':        '#1CADC6',
  'atlantic blue':         '#264E70',
  'steel blue':            '#4682B4',
  'slate':                 '#6A7B8C',
  'slate blue':            '#6A5ACD',
  'heather navy':          '#3F4A6B',
  'heather royal':         '#4F6BB2',
  'heather columbia blue': '#6FA5C8',
  'indigo':                '#4B0082',

  // ── purples ─────────────────────────────────────────────────────────
  'purple':                '#5A2D82',
  'deep purple':           '#3A1862',
  'team purple':           '#5E2C8E',
  'violet':                '#7F00FF',
  'lavender':              '#E6E6FA',
  'orchid':                '#DA70D6',
  'heather purple':        '#6F5499',

  // ── SanMar/ATC specialties ──────────────────────────────────────────
  'realtree xtra':         '#3F4F2F',
  'realtree edge':          '#5C6141',
  'realtree ap':           '#4A5D32',
  'mossy oak':             '#3B4423',
  'camo':                  '#4E5B31',
  'desert camo':           '#C3B091',
  'digital camo':          '#5B6D4C',
  'woodland camo':         '#4E5B31',
  'blaze orange':          '#FF5F00',
  'copper':                '#B87333',
  'rose gold':             '#B76E79',
  'berry':                 '#7E2F4C',
  'plum':                  '#8E4585',
  'eggplant':              '#614051',
  'pine':                  '#01796F',
  'spruce':                '#425947',
  'evergreen':             '#05472A',

  // ── heather "x" patterns we see a lot ───────────────────────────────
  'heather charcoal':      '#4C5257',
  'heather black':         '#2B2B2B',
  'heather white':         '#E8E8E8',
  'heather athletic grey': '#A7A9AC',
  'heather athletic gray': '#A7A9AC',
};

/**
 * Normalize a SanMar colour name into the form used as a MAP key.
 *
 * Handles the common noise SanMar feeds us:
 *   - ®/™/© trademark symbols          ("Realtree Xtra®"        → "realtree xtra")
 *   - parenthetical suffixes           ("Navy (Heather)"        → "navy")
 *   - asterisk decorators              ("Athletic Heather**"    → "athletic heather")
 *   - caret prefixes on safety colours ("^Safety Green"         → "safety green")
 *   - inseam suffixes on pants/shorts  ("Black Inseam 30\""     → "black")
 *   - leading/trailing + repeated ws   ("Athletic  Heather"     → "athletic heather")
 *   - case                             ("BLACK"                 → "black")
 *
 * Exported so the ingest/backfill paths can use the same canonical form.
 */
function normalizeColorName(colorName) {
  if (colorName == null) return '';
  return String(colorName)
    .replace(/[®™©]/g, '')                    // trademark symbols
    .replace(/\s*\([^)]*\)\s*/g, ' ')         // parenthetical suffixes
    .replace(/\*+/g, '')                      // asterisks anywhere
    .replace(/^\^+/, '')                      // leading carets
    .replace(/\s+inseam\s+\d+"?/gi, '')       // "Inseam 30\"" size suffix
    .trim()
    .toLowerCase()
    .replace(/\s+/g, ' ');
}

/**
 * Look up a hex code for a SanMar colour name.
 *
 * Match is case-insensitive, whitespace-trimmed, and aggressively normalized
 * (see normalizeColorName). For two-tone names ("Black/White", "Navy/Gold")
 * we fall back to the body colour (everything before the first slash), which
 * is SanMar's convention. Returns null for unknown names — caller writes
 * NULL and the UI shows a grey circle.
 *
 * @param {string|null|undefined} colorName  e.g. "Athletic Heather", "Realtree Xtra®", "Black/White"
 * @returns {string|null}  "#RRGGBB" or null
 */
function lookupHex(colorName) {
  const key = normalizeColorName(colorName);
  if (!key) return null;

  // Direct hit on the full (normalized) name
  if (MAP[key]) return MAP[key];

  // Two-tone fallback: use body colour only
  if (key.includes('/')) {
    const body = normalizeColorName(key.split('/')[0]);
    if (body && body !== key && MAP[body]) return MAP[body];
  }

  return null;
}

module.exports = { lookupHex, normalizeColorName, MAP };
