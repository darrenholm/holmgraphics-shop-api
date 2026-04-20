// suppliers/promostandards/inventory.js
//
// PromoStandards Inventory 2.0.0 client.
// Spec: https://tools.promostandards.org/inventory2-0-0
//
// Operations:
//   - getInventoryLevels        — live stock by part + warehouse.
//   - getFilterValues           — supported filter options.  [stubbed]
//
// SanMar Canada warehouses (FobId):
//   1 = Vancouver   · 2 = Mississauga   · 4 = Calgary

const { soapCall } = require('../common/soap-client');
const { normaliseMessages, assertNoErrors } = require('../common/service-messages');

const NAMESPACE  = 'http://www.promostandards.org/WSDL/Inventory/2.0.0/';
const WS_VERSION = '2.0.0';

/**
 * getInventoryLevels — live stock for every variant of a product.
 *
 * @param {object}   config
 * @param {object}   args
 * @param {string}   args.productId             required — the style
 * @param {string[]=} args.partIdArray          optional — only these parts
 * @param {string[]=} args.warehouseIdArray     optional — only these FOBs
 */
async function getInventoryLevels(config, args) {
  const { productId, partIdArray, warehouseIdArray } = args || {};
  if (!productId) throw new Error('getInventoryLevels: productId required');

  // Build the (optional) Filter subtree.
  const filter = {};
  if (partIdArray && partIdArray.length) {
    filter.partIdArray = { partId: partIdArray };
  }
  if (warehouseIdArray && warehouseIdArray.length) {
    filter.LabelSize = { labelSize: warehouseIdArray }; // some suppliers; ignored if unused
    filter.warehouseIdArray = { warehouseId: warehouseIdArray };
  }

  const body = {
    wsVersion: WS_VERSION,
    id:        config.credentials.id,
    password:  config.credentials.password,
    productId,
  };
  if (Object.keys(filter).length) body.Filter = filter;

  const response = await soapCall({
    endpoint:  config.endpoints.inventory,
    namespace: NAMESPACE,
    operation: 'GetInventoryLevels',
    body,
  });

  const payload  = response.GetInventoryLevelsResponse || {};
  const messages = normaliseMessages(payload.ServiceMessageArray);
  // Code 640 ("no inventory for criteria") isn't fatal — it just means
  // nothing stocked in those warehouses. Caller decides how to render.
  assertNoErrors(messages, { allowCodes: [201, 640] });

  const raw = payload.Inventory?.PartInventoryArray?.PartInventory
           ?? payload.PartInventoryArray?.PartInventory
           ?? [];
  const list = Array.isArray(raw) ? raw : [raw];

  const parts = list.map((pi) => {
    const locs = toArray(pi.InventoryLocationArray?.InventoryLocation);
    return {
      partId:         toStr(pi.partId),
      partColor:      toStr(pi.partColor),
      labelSize:      toStr(pi.labelSize),
      quantityTotal:  toInt(pi.quantityAvailable?.Quantity?.value)
                      ?? toInt(pi.quantityAvailable?.value)
                      ?? toInt(pi.quantityAvailable),
      locations: locs.map((l) => ({
        warehouseId:   toStr(l.inventoryLocationId),
        postalCode:    toStr(l.postalCode),
        country:       toStr(l.country),
        quantity:      toInt(l.inventoryLocationQuantity?.Quantity?.value)
                       ?? toInt(l.inventoryLocationQuantity?.value)
                       ?? toInt(l.inventoryLocationQuantity),
        expectedDate:  toStr(l.manufacturerStockEstimatedDate?.Estimate?.date)
                       ?? toStr(l.expectedDate),
        _raw:          l,
      })),
      _raw: pi,
    };
  });

  return { productId, parts, messages };
}

async function getFilterValues(_config, _args) {
  throw new Error('getFilterValues not yet implemented');
}

function toArray(v) {
  if (v === undefined || v === null) return [];
  return Array.isArray(v) ? v : [v];
}
function toStr(v) {
  if (v === undefined || v === null) return null;
  const s = String(v).trim();
  return s === '' ? null : s;
}
function toInt(v) {
  const s = toStr(v);
  if (s === null) return null;
  const n = Number(s);
  return Number.isFinite(n) ? Math.trunc(n) : null;
}

module.exports = { NAMESPACE, getInventoryLevels, getFilterValues };
