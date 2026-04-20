// suppliers/promostandards/purchase-order.js
//
// PromoStandards Purchase Order 1.0.0 client.
// Spec: https://tools.promostandards.org/standards/services
//
// Operations:
//   - sendPO                    — submit a purchase order to the supplier.
//
// This is the cash-register endpoint: called after Stripe payment confirms,
// to place the actual supplier order. Idempotency is the caller's problem —
// track our own PO number + status in the orders table before submitting.

const NAMESPACE = 'http://www.promostandards.org/WSDL/POService/1.0.0/';

// TODO(#45)
async function sendPO(_client, _args) { throw new Error('Not implemented (task #45)'); }

module.exports = { NAMESPACE, sendPO };
