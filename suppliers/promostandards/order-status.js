// suppliers/promostandards/order-status.js
//
// PromoStandards Order Status 2.0.0 client.
// Spec: https://tools.promostandards.org/standards/services
// (2.0 was ratified in Feb 2026 committee update.)
//
// Operations:
//   - getOrderStatus                 — current status of one or more POs.
//   - getOrderStatusDetails          — line-item-level status breakdown.
//   - getOrderStatusTypes            — list of valid status codes a
//                                      supplier may return.
//
// Poll this from a cron — daily or hourly — to keep our orders table
// in sync with the supplier's real state.

const NAMESPACE = 'http://www.promostandards.org/WSDL/OrderStatusService/2.0.0/';

// TODO(#45)
async function getOrderStatus(_client, _args)        { throw new Error('Not implemented (task #45)'); }
async function getOrderStatusDetails(_client, _args) { throw new Error('Not implemented (task #45)'); }
async function getOrderStatusTypes(_client, _args)   { throw new Error('Not implemented (task #45)'); }

module.exports = {
  NAMESPACE,
  getOrderStatus,
  getOrderStatusDetails,
  getOrderStatusTypes,
};
