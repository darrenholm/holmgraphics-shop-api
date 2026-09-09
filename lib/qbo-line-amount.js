// lib/qbo-line-amount.js
//
// One job: make Amount, UnitPrice and Qty on a QBO invoice line agree with
// each other before we send them.
//
// QBO validates `Amount === UnitPrice * Qty` and rejects the whole invoice
// with error 6070 ("Amount calculation incorrect in the request") if it
// doesn't hold. Our pricing code deliberately treats the line TOTAL as
// authoritative and derives the per-unit figure from it — see the comment
// in lib/election-catalogue.js priceSigns: a whole-sheet order priced per
// sign and multiplied back is out by a few cents, which a customer checking
// the arithmetic will find. So `unit_price` is stored rounded to the cent
// for display and `total` is the real number.
//
// That's correct for us and invalid for QBO. Example that failed on job
// #9979: 48 lawn signs, total $451.50, stored unit_price $9.41.
// 48 × 9.41 = $451.68, so QBO threw 6070 and nothing synced.
//
// The fix keeps the total authoritative — it's what the customer owes and
// what the job board shows — and re-derives UnitPrice from it at the five
// decimal places QBO stores. 451.50 / 48 = 9.40625 exactly, which multiplies
// back to 451.50 and passes validation. The invoice still DISPLAYS $9.41.

'use strict';

// QBO stores UnitPrice to five decimal places. More than that and it rounds
// server-side, which puts us straight back into a 6070.
const UNIT_PRICE_DP = 5;

function roundTo(n, dp) {
  const f = 10 ** dp;
  // Math.round is asymmetric on negatives (Math.round(-0.5) === -0), which
  // matters for credit/discount lines. Round the magnitude, reapply the sign.
  return Math.sign(n) * Math.round(Math.abs(n) * f + Number.EPSILON) / f;
}

/**
 * Build the QBO-safe { Amount, UnitPrice, Qty } trio for one invoice line.
 *
 * @param {object}  line
 * @param {number|string} line.amount     line total (authoritative)
 * @param {number|string} [line.unitPrice] fallback if amount is unusable
 * @param {number|string} [line.qty]
 * @returns {{ Amount: number, UnitPrice: number, Qty: number }}
 */
function qboLineAmounts({ amount, unitPrice, qty }) {
  const q = Number(qty);
  let a = Number(amount);

  // No usable total — fall back to unit × qty, which is at least consistent.
  if (!Number.isFinite(a)) {
    const u = Number(unitPrice);
    if (!Number.isFinite(u)) return { Amount: 0, UnitPrice: 0, Qty: 1 };
    const n = Number.isFinite(q) && q !== 0 ? q : 1;
    return { Amount: roundTo(u * n, 2), UnitPrice: u, Qty: n };
  }

  a = roundTo(a, 2);

  // Zero or missing qty can't be divided by. Bill it as a single unit; the
  // real count is already in the line description on every one of our paths.
  if (!Number.isFinite(q) || q === 0) {
    return { Amount: a, UnitPrice: a, Qty: 1 };
  }

  const derived = roundTo(a / q, UNIT_PRICE_DP);

  // Re-derive the amount from the rounded unit price rather than trusting
  // that they still agree. They almost always do; where a/q isn't
  // representable in five decimals (100 / 3) the product lands within a
  // fraction of a cent and rounds back to the same cent.
  return { Amount: roundTo(derived * q, 2), UnitPrice: derived, Qty: q };
}

module.exports = { qboLineAmounts };
