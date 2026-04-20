// suppliers/ss_activewear/config.js
//
// S&S Activewear supplier adapter — CREDENTIALS PENDING.
// PromoStandards-compliant. Once creds + endpoints arrive, this file +
// an index.js wrapping ../promostandards/* is all that's needed.
//
// Task #62 tracks the onboarding.

const ENDPOINTS = {
  // TODO(#62): fill in from S&S onboarding packet.
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
  const env = (process.env.SS_ACTIVEWEAR_ENV || 'uat').toLowerCase();
  const username = process.env.SS_ACTIVEWEAR_USERNAME;
  const password = process.env.SS_ACTIVEWEAR_PASSWORD;
  if (!username || !password) {
    throw new Error('SS_ACTIVEWEAR_USERNAME and SS_ACTIVEWEAR_PASSWORD must be set');
  }
  return {
    supplierCode: 'ss_activewear',
    env,
    endpoints: ENDPOINTS[env],
    credentials: { id: username, password },
  };
}

module.exports = { ENDPOINTS, loadConfig };
