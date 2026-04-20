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
  FLEECE:      'fleece',        // sweatshirts, hoodies, fleece, sweaters
  OUTERWEAR:   'outerwear',     // jackets, vests, parkas, softshells
  HEADWEAR:    'headwear',      // caps, hats, beanies, visors
  BAGS:        'bags',
  BOTTOMS:     'bottoms',       // pants, shorts, joggers
  ACTIVEWEAR:  'activewear',    // performance, athletic
  WORKWEAR:    'workwear',
  ACCESSORIES: 'accessories',   // towels, blankets, scarves, socks
  YOUTH:       'youth',         // supplier-tagged youth/infant/toddler
  LADIES:      'ladies',        // rarely the only tag; usually pairs with a type
  OTHER:       'other',
});

// Display labels for the UI. The storefront can import this to render pills.
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

// Ordered rules — first match wins. More specific patterns come first
// (e.g. "FLEECE JACKET" is outerwear, not fleece-pullover).
const RULES = [
  // Outerwear first — "FLEECE JACKET" / "SOFTSHELL JACKET" beat generic fleece.
  [/\b(JACKET|PARKA|VEST|SOFTSHELL|RAIN|PUFFER|COAT|ANORAK|WINDBREAKER|OUTERWEAR)\b/i,  CATEGORIES.OUTERWEAR],

  // Headwear.
  [/\b(CAP|HAT|BEANIE|VISOR|TOQUE|HEADWEAR|BUCKET)\b/i,                                 CATEGORIES.HEADWEAR],

  // Bags.
  [/\b(BAG|TOTE|BACKPACK|DUFFLE|DUFFEL|POUCH|SACK|LUGGAGE)\b/i,                         CATEGORIES.BAGS],

  // Polos / knits.
  [/\b(POLO|KNIT)\b/i,                                                                  CATEGORIES.POLOS],

  // Woven / button-ups.
  [/\b(WOVEN|BUTTON|DRESS SHIRT|OXFORD|POPLIN|FLANNEL|DENIM SHIRT)\b/i,                 CATEGORIES.WOVEN],

  // Fleece / sweats / hoodies.
  [/\b(HOODIE|HOODED|SWEATSHIRT|CREWNECK|PULLOVER|FLEECE|SWEATER)\b/i,                  CATEGORIES.FLEECE],

  // Bottoms.
  [/\b(PANT|SHORT|JOGGER|SWEATPANT|LEGGING|TROUSER|SKIRT)\b/i,                          CATEGORIES.BOTTOMS],

  // T-shirts.
  [/\b(T[- ]?SHIRT|TEE|TANK|MUSCLE)\b/i,                                                CATEGORIES.T_SHIRTS],

  // Activewear / performance — catch this after garment-type rules so a
  // "PERFORMANCE POLO" still classifies as a polo.
  [/\b(ACTIVEWEAR|PERFORMANCE|ATHLETIC|SPORTS)\b/i,                                     CATEGORIES.ACTIVEWEAR],

  // Workwear.
  [/\b(WORKWEAR|HI-?VIS|SAFETY|COVERALL|MECHANIC)\b/i,                                  CATEGORIES.WORKWEAR],

  // Youth / infant / toddler as a last-resort type (SanMar sometimes
  // tags only by demographic when the garment spans categories).
  [/\b(YOUTH|INFANT|TODDLER|BABY|KIDS?)\b/i,                                            CATEGORIES.YOUTH],

  // Ladies as last-resort type.
  [/\b(LADIES|WOMEN'?S?)\b/i,                                                           CATEGORIES.LADIES],

  // Accessories catch-all.
  [/\b(TOWEL|BLANKET|SCARF|SOCK|GLOVE|APRON|UMBRELLA|ACCESSOR)\b/i,                     CATEGORIES.ACCESSORIES],
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
