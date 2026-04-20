// suppliers/sanmar/index.js
//
// SanMar Canada supplier adapter — top-level entry point. Combines the
// SanMar-specific config (endpoints, credentials, warehouses) with the
// generic PromoStandards service clients. Other code in the API should
// import this module, not the individual service files, so swapping
// suppliers is a one-line change at the call site.

const config      = require('./config');
const bulkData    = require('./bulk-data');
const productData = require('../promostandards/product-data');
const mediaContent = require('../promostandards/media-content');
const inventory    = require('../promostandards/inventory');
const pricing      = require('../promostandards/pricing');
const purchaseOrder  = require('../promostandards/purchase-order');
const orderStatus    = require('../promostandards/order-status');
const shipmentNotification = require('../promostandards/shipment-notification');
const invoice        = require('../promostandards/invoice');

function makeClient() {
  const cfg = config.loadConfig();
  return {
    supplierCode: cfg.supplierCode,
    config: cfg,

    // SanMar-specific (non-PS)
    getBulkData: () => bulkData.getBulkData(cfg),

    // PromoStandards — each service reads endpoints/credentials off cfg.
    // These stay stubbed until task #45 fills them in.
    productData: {
      getProduct:              (args) => productData.getProduct(cfg, args),
      getProductSellable:      (args) => productData.getProductSellable(cfg, args),
      getProductCloseOut:      (args) => productData.getProductCloseOut(cfg, args),
      getProductDateModified:  (args) => productData.getProductDateModified(cfg, args),
    },
    mediaContent: {
      getMediaContent:         (args) => mediaContent.getMediaContent(cfg, args),
      getMediaDateModified:    (args) => mediaContent.getMediaDateModified(cfg, args),
    },
    inventory: {
      getInventoryLevels:      (args) => inventory.getInventoryLevels(cfg, args),
      getFilterValues:         (args) => inventory.getFilterValues(cfg, args),
    },
    pricing: {
      getAvailableLocations:      (args) => pricing.getAvailableLocations(cfg, args),
      getDecorationColors:        (args) => pricing.getDecorationColors(cfg, args),
      getConfigurationAndPricing: (args) => pricing.getConfigurationAndPricing(cfg, args),
      getFobPoints:               (args) => pricing.getFobPoints(cfg, args),
    },
    purchaseOrder: {
      sendPO:                     (args) => purchaseOrder.sendPO(cfg, args),
    },
    orderStatus: {
      getOrderStatus:             (args) => orderStatus.getOrderStatus(cfg, args),
      getOrderStatusDetails:      (args) => orderStatus.getOrderStatusDetails(cfg, args),
      getOrderStatusTypes:        (args) => orderStatus.getOrderStatusTypes(cfg, args),
    },
    shipmentNotification: {
      getOrderShipmentNotification: (args) => shipmentNotification.getOrderShipmentNotification(cfg, args),
    },
    invoice: {
      getInvoices:                (args) => invoice.getInvoices(cfg, args),
    },
  };
}

module.exports = { makeClient, config };
