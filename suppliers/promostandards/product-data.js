// suppliers/promostandards/product-data.js
//
// PromoStandards Product Data 2.0.0 client.
// Spec: https://tools.promostandards.org/standards/services
//
// Operations:
//   - getProduct                 — full metadata for one style/productId.
//   - getProductSellable         — list variants (parts) still orderable.
//   - getProductCloseOut         — list discontinued variants.   [stubbed]
//   - getProductDateModified     — delta ingest IDs since date.  [stubbed]
//
// Works against any PS-compliant supplier — endpoint + credentials come
// from the supplier adapter (suppliers/<vendor>/config.js).

const { soapCall } = require('../common/soap-client');
const { normaliseMessages, assertNoErrors } = require('../common/service-messages');

const NAMESPACE  = 'http://www.promostandards.org/WSDL/ProductDataService/2.0.0/';
const WS_VERSION = '2.0.0';

/**
 * getProduct — full product + variant metadata.
 *
 * @param {object} config      supplier config (loadConfig() output)
 * @param {object} args
 * @param {string} args.productId              required — the style / parent SKU
 * @param {string=} args.localizationCountry   default 'CA'
 * @param {string=} args.localizationLanguage  default 'en'
 */
async function getProduct(config, args) {
  const { productId, localizationCountry = 'CA', localizationLanguage = 'en' } = args || {};
  if (!productId) throw new Error('getProduct: productId required');

  const response = await soapCall({
    endpoint:  config.endpoints.productData,
    namespace: NAMESPACE,
    operation: 'GetProduct',
    body: {
      wsVersion: WS_VERSION,
      id:        config.credentials.id,
      password:  config.credentials.password,
      localizationCountry,
      localizationLanguage,
      productId,
    },
  });

  const payload  = response.GetProductResponse || {};
  const messages = normaliseMessages(payload.ServiceMessageArray);
  assertNoErrors(messages, { allowCodes: [201] });

  const product = payload.Product || {};
  return {
    productId:    toStr(product.productId) || productId,
    productName:  toStr(product.productName),
    description:  toStr(product.description),
    brand:        toStr(product.productBrand),
    category:     toStr(product.productCategory),
    isCaution:    toBool(product.isCaution),
    isCloseout:   toBool(product.isCloseout),
    parts:        normaliseParts(product.ProductPartArray),
    messages,
    _raw:         product,
  };
}

/**
 * getProductSellable — short list of still-orderable part IDs.
 *
 * @param {object} config
 * @param {object} args
 * @param {string} args.productId  required
 */
async function getProductSellable(config, args) {
  const { productId } = args || {};
  if (!productId) throw new Error('getProductSellable: productId required');

  const response = await soapCall({
    endpoint:  config.endpoints.productData,
    namespace: NAMESPACE,
    operation: 'GetProductSellable',
    body: {
      wsVersion: WS_VERSION,
      id:        config.credentials.id,
      password:  config.credentials.password,
      productId,
    },
  });

  const payload  = response.GetProductSellableResponse || {};
  const messages = normaliseMessages(payload.ServiceMessageArray);
  assertNoErrors(messages, { allowCodes: [201] });

  const raw = payload.ProductSellableArray?.ProductSellable
           ?? payload.ProductSellable
           ?? [];
  const list = Array.isArray(raw) ? raw : [raw];
  const parts = list.map((p) => ({
    partId:     toStr(p.partId),
    isSellable: toBool(p.isSellable),
  }));

  return { productId, parts, messages };
}

// Stubbed — implement on demand. Spec operations listed for completeness.
async function getProductCloseOut(_config, _args) {
  throw new Error('getProductCloseOut not yet implemented (use bulk-data + is_discontinued flag for now)');
}
async function getProductDateModified(_config, _args) {
  throw new Error('getProductDateModified not yet implemented (use nightly bulk-data full sync for now)');
}

// ── helpers ─────────────────────────────────────────────────────────────

function normaliseParts(partArray) {
  if (!partArray) return [];
  const raw = partArray.ProductPart || [];
  const list = Array.isArray(raw) ? raw : [raw];
  return list.map((p) => {
    const colors = toArray(p.ColorArray?.Color);
    const sizes  = toArray(p.ApparelSize);
    const color0 = colors[0] || {};
    const size0  = sizes[0]  || {};
    return {
      partId:           toStr(p.partId),
      partDescription:  toStr(p.partDescription),
      partBrand:        toStr(p.partBrand),
      colorName:        toStr(color0.colorName)  || toStr(p.colorName),
      colorHex:         toStr(color0.hex)        || toStr(p.colorHex),
      colorGroup:       toStr(color0.colorGroup) || null,
      size:             toStr(size0.apparelSize) || toStr(p.size) || toStr(size0),
      gtin:             toStr(p.gtin),
      partGroupRequired: toBool(p.partGroupRequired),
      _raw:             p,
    };
  });
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
function toBool(v) {
  if (v === undefined || v === null) return null;
  if (typeof v === 'boolean') return v;
  return String(v).trim().toLowerCase() === 'true';
}

module.exports = {
  NAMESPACE,
  getProduct,
  getProductSellable,
  getProductCloseOut,
  getProductDateModified,
};
