// suppliers/sanmar/config.js
//
// SanMar Canada supplier adapter — endpoints, credentials, warehouse IDs.
// Credentials are read from env vars (set in Railway).
//
// Account #26562. Account rep confirmed static IP not required for NA.

// Endpoint URLs straight out of the SanMar Canada PromoStandards Web
// Services Integration Guide (2025 beta, account #26562). UAT is reached
// via the /uat-ws/ prefix; production uses /pstd/ with each service living
// under its own /<service><version>/ subpath. MediaContent in production
// supports both 1.1 and 1.2 — we use 1.2 because the response shape is one
// MediaContent element per image URL (1.1 crams multiple URLs into a single
// <url> element as whitespace-separated text). Bulk Data is SanMar-specific
// and doesn't live under the PromoStandards tree at all.
const ENDPOINTS = {
  uat: {
    productData:         'https://edi.atc-apparel.com/uat-ws/promostandards/productdata2.0/ProductDataServiceV2.php',
    mediaContent:        'https://edi.atc-apparel.com/uat-ws/promostandards/mediacontent1.1/MediaContentService.php',
    inventory:           'https://edi.atc-apparel.com/uat-ws/promostandards/inventory2.0/InventoryServiceV2.php',
    pricing:             'https://edi.atc-apparel.com/uat-ws/promostandards/productpricingconfiguration/PricingAndConfigurationService.php',
    purchaseOrder:       'https://edi.atc-apparel.com/uat-ws/promostandards/purchaseorder/POService.php',
    orderStatus:         'https://edi.atc-apparel.com/uat-ws/promostandards/orderstatus2.0/OrderStatusServiceV2.php',
    shipmentNotification:'https://edi.atc-apparel.com/uat-ws/promostandards/osn2.0/OrderShipmentNotificationServiceV2.php',
    invoice:             'https://edi.atc-apparel.com/uat-ws/promostandards/invoice1.0/InvoiceService.php',
    bulkData:            'https://edi.atc-apparel.com/bulk-data/BulkDataService.php',
  },
  production: {
    productData:         'https://edi.atc-apparel.com/pstd/productdata2.0/ProductDataServiceV2.php',
    mediaContent:        'https://edi.atc-apparel.com/pstd/mediacontent1.2/MediaContentService.php',
    inventory:           'https://edi.atc-apparel.com/pstd/inventory2.0/InventoryServiceV2.php',
    pricing:             'https://edi.atc-apparel.com/pstd/productpricingconfiguration/PricingAndConfigurationService.php',
    purchaseOrder:       'https://edi.atc-apparel.com/pstd/purchaseorder/POService.php',
    orderStatus:         'https://edi.atc-apparel.com/pstd/orderstatus2.0/OrderStatusServiceV2.php',
    shipmentNotification:'https://edi.atc-apparel.com/pstd/osn2.0/OrderShipmentNotificationServiceV2.php',
    invoice:             'https://edi.atc-apparel.com/pstd/invoice1.0/InvoiceService.php',
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
