// lib/stripe-fee.js
//
// Fills in a sale's Stripe fee when it wasn't known at payment time, then
// posts it to QuickBooks.
//
// A card-present (reader) charge has its balance transaction — the only
// place the fee lives — by the time payment_intent.succeeded arrives. A
// keyed or online `card` charge often doesn't: Stripe builds it a few
// seconds later. Found on the first phone payment, 2026-09-30: the sale
// posted, the fee didn't, and the clearing account would never have zeroed.
//
// writeBackPayment already knows how to post a missing fee for a synced
// row; this just gets the number onto the row first.

'use strict';

const { query, queryOne } = require('../db/connection');
const { getStripe } = require('./stripe-client');
const { writeBackPayment } = require('./qbo-terminal-writeback');

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// One look at Stripe. Returns true once the row has a fee.
async function refreshStripeFee(terminalPaymentId) {
  const row = await queryOne(`SELECT * FROM terminal_payments WHERE id = $1`, [terminalPaymentId]);
  if (!row) throw new Error(`terminal_payments #${terminalPaymentId} not found`);
  if (row.fee_cents != null) return true;
  if (!row.charge_id) return false;

  const charge = await getStripe().charges.retrieve(row.charge_id, { expand: ['balance_transaction'] });
  const bt = charge.balance_transaction;
  if (!bt || typeof bt !== 'object') return false;

  await query(
    `UPDATE terminal_payments
        SET fee_cents = $1, net_cents = $2, updated_at = NOW()
      WHERE id = $3 AND fee_cents IS NULL`,
    [bt.fee, bt.net, row.id]
  );
  // Posts the fee if the sale is already in QuickBooks, or the whole sale
  // with its fee if it isn't yet.
  await writeBackPayment(row.id);
  return true;
}

// Called from the webhook after the sale has posted. Webhook work runs after
// Stripe has been acknowledged, so waiting here holds nothing up.
async function waitForStripeFee(terminalPaymentId, { attempts = 8, delayMs = 15_000 } = {}) {
  for (let i = 0; i < attempts; i++) {
    await sleep(delayMs);
    try {
      if (await refreshStripeFee(terminalPaymentId)) return true;
    } catch (err) {
      console.error(`[stripe-fee] #${terminalPaymentId}:`, err.message);
    }
  }
  console.error(`[stripe-fee] #${terminalPaymentId}: no fee after ${attempts} tries — use Resync on /pos`);
  return false;
}

module.exports = { refreshStripeFee, waitForStripeFee };
