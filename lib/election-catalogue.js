// lib/election-catalogue.js
//
// What a municipal candidate can order, and what it costs.
//
// This is the shop's price list for election work, in one place. The customer
// picks from it, the server prices from it, and the job that lands on the board
// carries the figures it produced. A candidate never sees a trade cost.
//
// WHY IT IS HERE AND NOT IN A TABLE. It changes when Darren changes it, which
// is a release, not a customer action — and a price change arriving in a commit
// with the old numbers still readable in the history is worth more than an admin
// screen nobody uses. The DTF pricing is in tables because it is edited often
// and by print location; this is edited once a term.
//
// MONEY IS DOLLARS, two decimals, like the rest of this API. (The election
// portal that this replaces used integer cents; the conversion happened once,
// here, when the price list moved.)
//
// ITEM TYPES. Every line a job carries is one of three, which is what the shop
// sorts work by:
//
//   CoroplastSign   cut and printed here, from 4' x 8' sheet
//   Printing        cards and hangers, bought in from the trade printer
//   Apparel         shirts and hoodies — priced by the DTF engine, not here
//
'use strict';

// ─── the rules ───────────────────────────────────────────────────────────────

// Signs are bought by the sheet and cut. Every size below divides a 4' x 8'
// evenly, and the sheet is what the shop pays for whatever is done to it.
const SHEET_PRICES = {
  '4mm-single': 210.00,
  '6mm-single': 265.00,
  '4mm-double': 270.00,
  '6mm-double': 320.00,
};

// Every additional sheet takes another 5% off the whole order, to a floor of
// 25%: one sheet is list, two is 5% off, four is 15%, six or more is 25%.
// The saving is on the sheet because the cost is on the sheet — the second one
// goes through the same setup as the first.
const SHEET_DISCOUNT_PER_SHEET = 5;
const SHEET_DISCOUNT_MAX = 25;

// A wire H-stand. Only holds a sign up to 16 x 24; anything bigger goes on
// posts, and the cuts below say so.
const WIRE_STAND = 2.10;

// Artwork, charged once for the whole job when the candidate is not supplying
// print-ready files. Not per item: a campaign's signs, cards and hangers are
// one look, drawn once and adapted.
const ARTWORK_FEE = 45.00;

// Trade freight on bought-in print, folded into the price before markup so the
// figure on the page is the figure on the invoice.
const TRADE_FREIGHT = 25.00;
const PRINT_MARKUP_PERCENT = 50;

// Printing the back as well as the front. A proportion of the job rather than
// a flat figure, which would be wrong at both 500 and 5000.
const DOUBLE_SIDED_PERCENT = 8;

// Decals: cut from a 54" roll with 1" between, charged by the square foot of
// roll consumed, with a floor because a print run costs what it costs.
const ROLL_WIDTH_IN = 54;
const DECAL_GAP_IN = 1;
const DECAL_PER_SQ_FT = 8.00;
const DECAL_MINIMUM = 50.00;

// ─── sign cuts ───────────────────────────────────────────────────────────────

// How many of each cut come off one sheet, and how it has to be mounted.
// `stands` is false where a wire stand cannot hold it up.
const SIGN_CUTS = [
  { key: '12x12', name: '12" x 12"', perSheet: 32, stands: true },
  { key: '12x16', name: '12" x 16"', perSheet: 24, stands: true },
  { key: '16x24', name: '16" x 24"', perSheet: 12, stands: true },
  { key: '24x32', name: '24" x 32"', perSheet: 6,  stands: false },
  { key: '32x48', name: '32" x 48"', perSheet: 2,  stands: false },
  { key: '48x48', name: '48" x 48"', perSheet: 2,  stands: false },
  { key: '48x96', name: '48" x 96"', perSheet: 1,  stands: false },
];

// ─── bought-in print ─────────────────────────────────────────────────────────

// SinaLite's own trade cost, off the trade site on 5 September 2026. What the
// candidate pays is derived: freight in, then the markup.
function tradeRun(quantity, tradeCost) {
  const landed = tradeCost + TRADE_FREIGHT;
  return { quantity, price: round2(landed * (1 + PRINT_MARKUP_PERCENT / 100)) };
}

const PRINT_PRODUCTS = [
  {
    key: 'postcard-4.25x5.5',
    name: 'Post cards 4.25" x 5.5"',
    detail: '14pt card, UV high gloss',
    runs: [tradeRun(500, 43.95), tradeRun(1000, 48.80), tradeRun(2500, 97.75), tradeRun(5000, 168.00)],
  },
  {
    key: 'postcard-8.5x5.5',
    name: 'Post cards 8.5" x 5.5"',
    detail: '14pt card, UV high gloss',
    runs: [tradeRun(500, 72.50), tradeRun(1000, 93.40), tradeRun(2500, 195.50), tradeRun(5000, 291.50)],
  },
  {
    key: 'doorhanger-8.5x3.5',
    name: 'Door hangers 8.5" x 3.5"',
    detail: '14pt card, die-cut hanging hole',
    runs: [tradeRun(250, 70.22), tradeRun(500, 101.97), tradeRun(1000, 113.04), tradeRun(2500, 197.55)],
  },
];

// ─── helpers ─────────────────────────────────────────────────────────────────

function round2(n) {
  if (!Number.isFinite(n)) return 0;
  return Math.round(n * 100) / 100;
}

function sheetDiscountPercent(sheets) {
  if (sheets <= 1) return 0;
  return Math.min(SHEET_DISCOUNT_MAX, (sheets - 1) * SHEET_DISCOUNT_PER_SHEET);
}

// ─── pricing ─────────────────────────────────────────────────────────────────

/**
 * Price a run of signs.
 *
 * Whole sheets, rounded up: 13 of a 12-up cut consumes two sheets and is
 * charged as two, because the shop has cut into the second one either way —
 * and the other eleven signs are worth more in a candidate's garage than in
 * the offcut bin.
 *
 * The sheet total is authoritative and the per-sign figure is derived from it.
 * Rounding per sign and multiplying back puts a whole-sheet order out by a few
 * cents, which a candidate checking the arithmetic will find.
 */
function priceSigns({ cutKey, sheetKey, quantity, stands }) {
  const cut = SIGN_CUTS.find((c) => c.key === cutKey);
  const sheetPrice = SHEET_PRICES[sheetKey];
  if (!cut || sheetPrice == null) return null;

  const wanted = Math.max(1, Math.round(Number(quantity) || 0));
  const sheets = Math.max(1, Math.ceil(wanted / cut.perSheet));
  const pieces = sheets * cut.perSheet;

  const discount = sheetDiscountPercent(sheets);
  const goods = round2(sheets * sheetPrice * (1 - discount / 100));

  const standCount = standsWanted(stands, pieces, cut);
  const standsTotal = round2(standCount * WIRE_STAND);

  return {
    item_type: 'CoroplastSign',
    description:
      `${cut.name} coroplast sign, ${sheetLabel(sheetKey)}` +
      (standCount > 0 ? `, with ${standCount} wire stand${standCount === 1 ? '' : 's'}` : '') +
      (discount > 0 ? ` (${sheets} sheets, ${discount}% off)` : ''),
    quantity: pieces,
    unit_price: round2((goods + standsTotal) / pieces),
    total: round2(goods + standsTotal),
    sheets,
    stands: standCount,
    discount_percent: discount,
    mounting: cut.stands ? null : mountingNote(cut.key, sheetKey),
  };
}

/**
 * How many wire stands to charge for.
 *
 * A count, not a yes-or-no. Campaigns routinely want fewer stands than signs
 * because a good number go on utility poles and fences, and charging a stand
 * for every sign would quietly overcharge the ones that do it properly.
 *
 * More stands than signs is allowed rather than clamped: a candidate who asks
 * for spares knows they will lose some to wind and lawnmowers.
 *
 * `true` still means one per sign, because drafts saved before this was a
 * number carry a boolean and should keep pricing the way they were quoted.
 */
function standsWanted(stands, pieces, cut) {
  if (!cut.stands) return 0;
  if (stands === true) return pieces;
  if (stands === false || stands == null) return 0;
  const n = Math.round(Number(stands));
  return Number.isFinite(n) && n > 0 ? n : 0;
}

function sheetLabel(sheetKey) {
  const [thickness, sides] = sheetKey.split('-');
  return `${thickness} ${sides === 'double' ? 'double-sided' : 'single-sided'}`;
}

// What the shop tells a candidate about holding a large sign up. Coroplast is
// not strong enough to bridge two posts at the ends, so a double-sided large
// sign is worse than two single-sided ones back to back.
function mountingNote(cutKey, sheetKey) {
  const double = sheetKey.endsWith('double');
  const thin = sheetKey.startsWith('4mm');
  if (double) {
    return 'Two single-sided signs with the posts in between read better than one ' +
      'double-sided sign — coroplast will not bridge between posts at the ends.';
  }
  return thin
    ? 'On 4mm this size needs a plywood or similar backer.'
    : '6mm at this size is fine with some strapping.';
}

/** Price a run of bought-in print. Fixed runs: the run has a price of its own. */
function pricePrint({ productKey, quantity, doubleSided }) {
  const product = PRINT_PRODUCTS.find((p) => p.key === productKey);
  if (!product) return null;

  // Drop to the largest run at or below what was asked for: a campaign that
  // asked for 500 should not be billed for 1000.
  const runs = [...product.runs].sort((a, b) => a.quantity - b.quantity);
  let run = runs[0];
  for (const r of runs) if (Number(quantity) >= r.quantity) run = r;

  const total = round2(run.price * (1 + (doubleSided ? DOUBLE_SIDED_PERCENT : 0) / 100));
  return {
    item_type: 'Printing',
    description:
      `${product.name} — ${product.detail}, ` +
      `${doubleSided ? 'printed both sides' : 'printed one side'}. Shipping included.`,
    quantity: run.quantity,
    unit_price: round2(total / run.quantity),
    total,
  };
}

/**
 * Price a run of decals.
 *
 * Charged by the roll consumed, not by the decal: they are nested across a 54"
 * roll with an inch between, and what the shop buys is the length that comes
 * off it. A minimum applies because a print run costs what it costs whether it
 * is one decal or twenty.
 */
function priceDecals({ widthIn, heightIn, quantity }) {
  const w = Number(widthIn);
  const h = Number(heightIn);
  const n = Math.max(1, Math.round(Number(quantity) || 0));
  if (!(w > 0) || !(h > 0) || w > ROLL_WIDTH_IN) return null;

  const across = Math.max(1, Math.floor((ROLL_WIDTH_IN + DECAL_GAP_IN) / (w + DECAL_GAP_IN)));
  const rows = Math.ceil(n / across);
  const lengthIn = rows * h + (rows - 1) * DECAL_GAP_IN;
  const squareFeet = (ROLL_WIDTH_IN * lengthIn) / 144;

  const computed = round2(squareFeet * DECAL_PER_SQ_FT);
  const total = Math.max(computed, DECAL_MINIMUM);

  return {
    item_type: 'Printing',
    // How they nest on the roll is the shop's arithmetic, not the candidate's.
    // "13 across, 8 rows, 11.63 sq ft" is a true sentence that tells somebody
    // buying decals nothing they can act on.
    description:
      `Vinyl decals ${w}" x ${h}"` +
      (total > computed ? ` (charged at the $${DECAL_MINIMUM.toFixed(2)} minimum)` : ''),
    quantity: n,
    unit_price: round2(total / n),
    total: round2(total),
    minimum_applied: total > computed,
  };
}

/** The whole order, as job line items. Artwork is one line, once. */
function priceOrder({ signs = [], print = [], decals = [], needsArtwork = false }) {
  const lines = [];

  // `source` is how the form puts a price beside the row that produced it.
  // Index alignment alone will not do: a row that cannot be priced — a decal
  // wider than the roll — produces no line, and everything after it would
  // shift up by one and label the wrong row.
  signs.forEach((s, index) => {
    const line = priceSigns(s);
    if (line) lines.push({ ...line, source: { kind: 'signs', index } });
  });
  print.forEach((p, index) => {
    const line = pricePrint(p);
    if (line) lines.push({ ...line, source: { kind: 'print', index } });
  });
  decals.forEach((d, index) => {
    const line = priceDecals(d);
    if (line) lines.push({ ...line, source: { kind: 'decals', index } });
  });

  if (needsArtwork && lines.length > 0) {
    lines.push({
      item_type: 'Printing',
      description: 'Artwork — one charge for the whole job, however many pieces are on it',
      quantity: 1,
      unit_price: ARTWORK_FEE,
      total: ARTWORK_FEE,
      source: { kind: 'artwork', index: 0 },
    });
  }

  const subtotal = round2(lines.reduce((sum, l) => sum + l.total, 0));
  return { lines, subtotal };
}

/**
 * The cheapest a sign can be had for, per sign.
 *
 * For the "from $x" on a catalogue card: the cut that yields most from the
 * cheapest sheet. A candidate reads it as "signs start about here", which is
 * what it is.
 */
function signFrom() {
  const cheapestSheet = Math.min(...Object.values(SHEET_PRICES));
  const mostPerSheet = Math.max(...SIGN_CUTS.map((c) => c.perSheet));
  return round2(cheapestSheet / mostPerSheet);
}

/** What the storefront renders its form from. No costs, only what is sold. */
function catalogue() {
  return {
    sign_cuts: SIGN_CUTS,
    sign_from: signFrom(),
    sheet_options: Object.keys(SHEET_PRICES).map((key) => ({ key, name: sheetLabel(key) })),
    print_products: PRINT_PRODUCTS.map(({ key, name, detail, runs }) => ({
      key, name, detail,
      // The smallest run and what it costs, which is the "from" on the card.
      from: runs[0].price,
      from_quantity: runs[0].quantity,
      runs: runs.map((r) => ({ quantity: r.quantity, price: r.price })),
    })),
    decals: {
      roll_width_in: ROLL_WIDTH_IN,
      per_sq_ft: DECAL_PER_SQ_FT,
      minimum: DECAL_MINIMUM,
    },
    fees: {
      artwork: ARTWORK_FEE,
      wire_stand: WIRE_STAND,
      double_sided_percent: DOUBLE_SIDED_PERCENT,
    },
  };
}

module.exports = {
  SIGN_CUTS,
  signFrom,
  SHEET_PRICES,
  ARTWORK_FEE,
  WIRE_STAND,
  DECAL_MINIMUM,
  catalogue,
  priceSigns,
  pricePrint,
  priceDecals,
  priceOrder,
  sheetDiscountPercent,
  round2,
};
