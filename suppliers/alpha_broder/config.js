// suppliers/alpha_broder/config.js
//
// AlphaBroder supplier adapter — CREDENTIALS PENDING.
// PromoStandards-compliant. Once creds + endpoints arrive, this file +
// an index.js wrapping ../promostandards/* is all that's needed.
//
// Task #63 tracks the onboarding.

const ENDPOINTS = {
  // TODO(#63): fill in from AlphaBroder onboarding packet.
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
  const env = (process.env.ALPHA_BRODER_ENV || 'uat').toLowerCase();
  const username = process.env.ALPHA_BRODER_USERNAME;
  const password = process.env.ALPHA_BRODER_PASSWORD;
  if (!username || !password) {
    throw new Error('ALPHA_BRODER_USERNAME and ALPHA_BRODER_PASSWORD must be set');
  }
  return {
    supplierCode: 'alpha_broder',
    env,
    endpoints: ENDPOINTS[env],
    credentials: { id: username, password },
  };
}

module.exports = { ENDPOINTS, loadConfig };
