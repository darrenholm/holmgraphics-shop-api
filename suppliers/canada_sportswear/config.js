// suppliers/canada_sportswear/config.js
//
// Canada Sportswear supplier adapter — CREDENTIALS PENDING.
// They publish a PromoStandards interface so once endpoints + creds
// arrive, this file + an index.js that imports ../promostandards/* is all
// that's needed. No new SOAP code required.
//
// Task #61 tracks the onboarding.

const ENDPOINTS = {
  // TODO(#61): fill in from Canada Sportswear onboarding packet.
  uat: {
    productData:          null,
    mediaContent:         null,
    inventory:            null,
    pricing:              null,
    purchaseOrder:        null,
    orderStatus:          null,
    shipmentNotification: null,
    invoice:              null,
  },
  production: {
    productData:          null,
    mediaContent:         null,
    inventory:            null,
    pricing:              null,
    purchaseOrder:        null,
    orderStatus:          null,
    shipmentNotification: null,
    invoice:              null,
  },
};

function loadConfig() {
  const env = (process.env.CANADA_SPORTSWEAR_ENV || 'uat').toLowerCase();
  const username = process.env.CANADA_SPORTSWEAR_USERNAME;
  const password = process.env.CANADA_SPORTSWEAR_PASSWORD;
  if (!username || !password) {
    throw new Error('CANADA_SPORTSWEAR_USERNAME and CANADA_SPORTSWEAR_PASSWORD must be set');
  }
  return {
    supplierCode: 'canada_sportswear',
    env,
    endpoints: ENDPOINTS[env],
    credentials: { id: username, password },
  };
}

module.exports = { ENDPOINTS, loadConfig };
