// suppliers/sanmar/category-map.js
//
// Maps raw PromoStandards category strings (from GetProduct V2.0.0
// ProductCategoryArray.category) onto the canonical buckets used in the
// storefront filter UI. Keeping this as a pure module with no DB access
// means we can tweak the mapping without redeploying the ingest — a
// re-run of the backfill (or the regular nightly) picks up the changes.
//
// The source strings are supplier-specific and SHOUTY (e.g. "T-SHIRTS",
// "POLOS/KNITS", "SWEATSHIRTS/FLEECE"). We match case-insensitively and
// bucket aggressively; anything we can't classify lands in 'other' and
// the raw string is preserved in category_raw so we can iterate.

// Canonical buckets. Keep in sync with the storefront pill bar.
const CATEGORIES = Object.freeze({
  T_SHIRTS:    't-shirts',
  POLOS:       'polos',
  WOVEN:       'woven-shirts',
  FLEECE:      'fleece',
  OUTERWEAR:   'outerwear',
  HEADWEAR:    'headwear',
  BAGS:        'bags',
  BOTTOMS:     'bottoms',
  ACTIVEWEAR:  'activewear',
  WORKWEAR:    'workwear',
  ACCESSORIES: 'accessories',
  YOUTH:       'youth',
  LADIES:      'ladies',
  OTHER:       'other',
});

// Display labels for the UI. The storefront imports these to render pills.
const LABELS = Object.freeze({
  't-shirts':     'T-Shirts',
  'polos':        'Polos',
  'woven-shirts': 'Woven Shirts',
  'fleece':       'Fleece & Hoodies',
  'outerwear':    'Outerwear',
  'headwear':     'Headwear',
  'bags':         'Bags',
  'bottoms':      'Bottoms',
  'activewear':   'Activewear',
  'workwear':     'Workwear',
  'accessories':  'Accessories',
  'youth':        'Youth',
  'ladies':       'Ladies',
  'other':        'Other',
});

// Ordered rules — first match wins. More specific patterns come first.
// Plurals: word boundaries don't fire between consecutive word chars,
// so every countable noun uses "NOUN?S?" to catch both forms.
const RULES = [
  [/\b(JACKETS?|PARKAS?|VESTS?|SOFTSHELLS?|RAINWEAR|PUFFERS?|COATS?|ANORAKS?|WINDBREAKERS?|OUTERWEAR)\b/i, CATEGORIES.OUTERWEAR],
  [/\b(CAPS?|HATS?|BEANIES?|VISORS?|TOQUES?|HEADWEAR|BUCKETS?)\b/i,                                       CATEGORIES.HEADWEAR],
  [/\b(BAGS?|TOTES?|BACKPACKS?|DUFFLES?|DUFFELS?|POUCHES?|SACKS?|LUGGAGE)\b/i,                            CATEGORIES.BAGS],
  [/\b(POLOS?|KNITS?)\b/i,                                                                                CATEGORIES.POLOS],
  [/\b(WOVENS?|BUTTON[- ]?UPS?|DRESS SHIRTS?|OXFORDS?|POPLIN|FLANNELS?|DENIM SHIRTS?)\b/i,                CATEGORIES.WOVEN],
  [/\b(HOODIES?|HOODED|SWEATSHIRTS?|CREWNECKS?|PULLOVERS?|FLEECE|SWEATERS?)\b/i,                          CATEGORIES.FLEECE],
  [/\b(PANTS?|SHORTS?|JOGGERS?|SWEATPANTS?|LEGGINGS?|TROUSERS?|SKIRTS?|BOTTOMS?)\b/i,                     CATEGORIES.BOTTOMS],
  [/\b(T[- ]?SHIRTS?|TEES?|TANKS?|MUSCLE)\b/i,                                                            CATEGORIES.T_SHIRTS],
  [/\b(ACTIVEWEAR|PERFORMANCE|ATHLETIC|SPORTS?)\b/i,                                                      CATEGORIES.ACTIVEWEAR],
  [/\b(WORKWEAR|HI-?VIS|SAFETY|COVERALLS?|MECHANIC)\b/i,                                                  CATEGORIES.WORKWEAR],
  [/\b(YOUTH|INFANT|TODDLER|BABY|KIDS?)\b/i,                                                              CATEGORIES.YOUTH],
  [/\b(LADIES|WOMEN'?S?|MATERNITY)\b/i,                                                                   CATEGORIES.LADIES],
  [/\b(TOWELS?|BLANKETS?|SCARF|SCARVES|SOCKS?|GLOVES?|APRONS?|UMBRELLAS?|ACCESSORIES?)\b/i,               CATEGORIES.ACCESSORIES],
];

/**
 * Canonicalize a raw supplier category string.
 * Returns a value from CATEGORIES. Never throws.
 */
function canonicalize(raw) {
  if (!raw) return CATEGORIES.OTHER;
  const s = String(raw).trim();
  if (!s) return CATEGORIES.OTHER;
  for (const [re, cat] of RULES) {
    if (re.test(s)) return cat;
  }
  return CATEGORIES.OTHER;
}

/**
 * Get the display label for a canonical category.
 */
function labelFor(cat) {
  return LABELS[cat] || LABELS.other;
}

/**
 * All canonical values, in the order we want them to appear in the UI.
 * "Other" is intentionally last.
 */
const UI_ORDER = Object.freeze([
  't-shirts',
  'polos',
  'woven-shirts',
  'fleece',
  'outerwear',
  'headwear',
  'activewear',
  'bottoms',
  'bags',
  'workwear',
  'accessories',
  'youth',
  'ladies',
  'other',
]);

module.exports = { CATEGORIES, LABELS, UI_ORDER, canonicalize, labelFor };
