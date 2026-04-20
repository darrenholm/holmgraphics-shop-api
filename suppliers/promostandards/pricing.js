// suppliers/promostandards/pricing.js
//
// PromoStandards Pricing & Configuration (PPC) 1.0.0 client.
// Spec: https://tools.promostandards.org/standards/services
//
// Operations:
//   - getConfigurationAndPricing — live pricing for a productId. This is
//                                  the one we actually need for v2.
//   - getAvailableLocations      — FOB points.           [stubbed]
//   - getDecorationColors        — decoration options.   [stubbed]
//   - getFobPoints               — ship-from locations.  [stubbed]
//
// SanMar Canada fixed request values: configurationType='Blank',
// priceType='Customer'. Currency 'CAD'.

const { soapCall } = require('../common/soap-client');
const { normaliseMessages, assertNoErrors } = require('../common/service-messages');

const NAMESPACE  = 'http://www.promostandards.org/WSDL/PricingAndConfiguration/1.0.0/';
const WS_VERSION = '1.0.0';

/**
 * getConfigurationAndPricing — live quantity-break pricing for a product.
 *
 * @param {object} config
 * @param {object} args
 * @param {string} args.productId              required
 * @param {string=} args.currency              default 'CAD'
 * @param {string=} args.fobId                 default first SanMar warehouse
 * @param {string=} args.priceType             default from config.pricingDefaults
 * @param {string=} args.configurationType     default from config.pricingDefaults
 * @param {string=} args.localizationCountry   default 'CA'
 * @param {string=} args.localizationLanguage  default 'en'
 */
async function getConfigurationAndPricing(config, args) {
  const {
    productId,
    currency             = 'CAD',
    fobId                = Object.keys(config.warehouses || { 1: true })[0],
    priceType            = config.pricingDefaults?.priceType         || 'Customer',
    configurationType    = config.pricingDefaults?.configurationType || 'Blank',
    localizationCountry  = 'CA',
    localizationLanguage = 'en',
  } = args || {};
  if (!productId) throw new Error('getConfigurationAndPricing: productId required');

  const response = await soapCall({
    endpoint:  config.endpoints.pricing,
    namespace: NAMESPACE,
    operation: 'getConfigurationAndPricing',
    body: {
      wsVersion: WS_VERSION,
      id:        config.credentials.id,
      password:  config.credentials.password,
      productId,
      currency,
      fobId: String(fobId),
      priceType,
      configurationType,
      localizationCountry,
      localizationLanguage,
    },
  });

  const payload  = response.getConfigurationAndPricingResponse
                ?? response.GetConfigurationAndPricingResponse
                ?? {};
  const messages = normaliseMessages(payload.ServiceMessageArray);
  assertNoErrors(messages, { allowCodes: [201] });

  const configs = toArray(
    payload.Configuration?.PartArray?.Part
    ?? payload.ProductConfigurationArray?.ProductConfiguration
    ?? payload.Configuration
  );

  const parts = configs.map((p) => {
    const priceRows = toArray(p.PartPriceArray?.PartPrice);
    return {
      partId:        toStr(p.partId),
      partDescription: toStr(p.partDescription),
      partBrand:     toStr(p.partBrand),
      priceRows: priceRows.map((pr) => ({
        minQuantity:  toInt(pr.minQuantity),
        maxQuantity:  toInt(pr.maxQuantity),
        price:        toNum(pr.price),
        discountCode: toStr(pr.discountCode),
        priceUom:     toStr(pr.priceUom),
        priceEffectiveDate: toStr(pr.priceEffectiveDate),
        priceExpiryDate:    toStr(pr.priceExpiryDate),
        _raw:         pr,
      })),
      _raw: p,
    };
  });

  return { productId, currency, fobId, parts, messages };
}

// Stubbed — implement on demand.
async function getAvailableLocations(_config, _args) {
  throw new Error('getAvailableLocations not yet implemented');
}
async function getDecorationColors(_config, _args) {
  throw new Error('getDecorationColors not yet implemented');
}
async function getFobPoints(_config, _args) {
  throw new Error('getFobPoints not yet implemented');
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
function toNum(v) {
  const s = toStr(v);
  if (s === null) return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}
function toInt(v) {
  const n = toNum(v);
  return n === null ? null : Math.trunc(n);
}

module.exports = {
  NAMESPACE,
  getConfigurationAndPricing,
  getAvailableLocations,
  getDecorationColors,
  getFobPoints,
};
