// suppliers/sanmar/config.js
//
// SanMar Canada supplier adapter — endpoints, credentials, warehouse IDs.
// Credentials are read from env vars (set in Railway).
//
// Account #26562. Account rep confirmed static IP not required for NA.

// Endpoint bases differ between UAT (sandbox) and production. SanMar's
// PromoStandards endpoints are the same URL family; only the credentials
// differ (sandbox creds vs production creds). Confirm against the
// integration guide before prod cutover.
const ENDPOINTS = {
  uat: {
    productData:         'https://edi.atc-apparel.com/promostandards/ProductDataService.php',
    mediaContent:        'https://edi.atc-apparel.com/promostandards/MediaContentService.php',
    inventory:           'https://edi.atc-apparel.com/promostandards/InventoryService.php',
    pricing:             'https://edi.atc-apparel.com/promostandards/PricingAndConfigurationService.php',
    purchaseOrder:       'https://edi.atc-apparel.com/promostandards/POService.php',
    orderStatus:         'https://edi.atc-apparel.com/promostandards/OrderStatusService.php',
    shipmentNotification:'https://edi.atc-apparel.com/promostandards/OrderShipmentNotificationService.php',
    invoice:             'https://edi.atc-apparel.com/promostandards/InvoiceService.php',
    bulkData:            'https://edi.atc-apparel.com/bulk-data/BulkDataService.php',
  },
  production: {
    // TODO(#44): confirm production endpoints from SanMar onboarding email
    // once we move off UAT. For now they mirror UAT.
    productData:         'https://edi.atc-apparel.com/promostandards/ProductDataService.php',
    mediaContent:        'https://edi.atc-apparel.com/promostandards/MediaContentService.php',
    inventory:           'https://edi.atc-apparel.com/promostandards/InventoryService.php',
    pricing:             'https://edi.atc-apparel.com/promostandards/PricingAndConfigurationService.php',
    purchaseOrder:       'https://edi.atc-apparel.com/promostandards/POService.php',
    orderStatus:         'https://edi.atc-apparel.com/promostandards/OrderStatusService.php',
    shipmentNotification:'https://edi.atc-apparel.com/promostandards/OrderShipmentNotificationService.php',
    invoice:             'https://edi.atc-apparel.com/promostandards/InvoiceService.php',
    bulkData:            'https://edi.atc-apparel.com/bulk-data/BulkDataService.php',
  },
};

// SanMar Canada warehouse (FobId) map. ID 3 was retired.
const WAREHOUSES = {
  1: { name: 'Vancouver',   postalCode: 'V6P 3G1', province: 'BC' },
  2: { name: 'Mississauga', postalCode: 'L5T 2N3', province: 'ON' },
  4: { name: 'Calgary',     postalCode: 'T2E 8Z9', province: 'AB' },
};

// Fixed request values SanMar CA requires for pricing calls.
const PRICING_DEFAULTS = {
  configurationType: 'Blank',
  priceType:         'Customer',
};

/**
 * Build a config object from environment. Throws if required creds are
 * missing — caller should let the error bubble to /health so we notice.
 */
function loadConfig() {
  const env = (process.env.SANMAR_ENV || 'uat').toLowerCase();
  if (!ENDPOINTS[env]) {
    throw new Error(`SANMAR_ENV must be 'uat' or 'production' (got '${env}')`);
  }

  const username = process.env.SANMAR_USERNAME;
  const password = process.env.SANMAR_PASSWORD;
  if (!username || !password) {
    throw new Error('SANMAR_USERNAME and SANMAR_PASSWORD must be set');
  }

  // Media Content service has its own password (SanMar quirk).
  const mediaPassword = process.env.SANMAR_MEDIA_PASSWORD || password;

  // Bulk Data sandbox uses a shared id/pwd. When real Bulk Data creds arrive,
  // fall back to SANMAR_USERNAME/PASSWORD in production.
  const bulkDataId       = process.env.SANMAR_BULK_DATA_ID       || (env === 'uat' ? 'sandbox'    : username);
  const bulkDataPassword = process.env.SANMAR_BULK_DATA_PASSWORD || (env === 'uat' ? 'sandbox123' : password);

  return {
    supplierCode: 'sanmar_ca',
    env,
    endpoints: ENDPOINTS[env],
    warehouses: WAREHOUSES,
    pricingDefaults: PRICING_DEFAULTS,
    credentials: {
      id:               username,
      password,
      mediaPassword,
      bulkDataId,
      bulkDataPassword,
    },
  };
}

module.exports = { ENDPOINTS, WAREHOUSES, PRICING_DEFAULTS, loadConfig };
