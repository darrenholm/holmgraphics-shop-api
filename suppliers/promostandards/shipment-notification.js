// suppliers/promostandards/shipment-notification.js
//
// PromoStandards Order Shipment Notification 2.0.0 client.
// Spec: https://tools.promostandards.org/standards/services
// (2.0 was ratified in Feb 2026 committee update.)
//
// Operations:
//   - getOrderShipmentNotification   — tracking numbers + ship dates by PO.
//
// Pair with Order Status polling: when status flips to "Shipped", call this
// to grab tracking data and email the customer.

const NAMESPACE = 'http://www.promostandards.org/WSDL/OrderShipmentNotificationService/2.0.0/';

// TODO(#45)
async function getOrderShipmentNotification(_client, _args) {
  throw new Error('Not implemented (task #45)');
}

module.exports = { NAMESPACE, getOrderShipmentNotification };
