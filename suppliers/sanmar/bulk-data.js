// suppliers/sanmar/bulk-data.js
//
// SanMar's Bulk Data service — NOT a PromoStandards service. One call
// returns the entire catalog (products + variants + stock + pricing +
// images + FR translations). Rate limit: 1 call per day.
//
// Response shape (confirmed against sandbox):
//   <GetBulkDataResponse>
//     <ProductInventoryArray>
//       <Product>
//         <productId>36016-2</productId>        -- variant SKU
//         <productName>ATC 1000 T-SHIRT</productName>
//         <frProductName>...</frProductName>
//         <style>ATC1000</style>                -- parent SKU
//         <size>S</size>
//         <swatchColor>Black</swatchColor>
//         <frSwatchColor>Noir</frSwatchColor>
//         <description>...</description>
//         <frDescription>...</frDescription>
//         <brand>ATC</brand>
//         <image>https://.../atc1000_black.jpg</image>
//         <weight>0.3125</weight>
//         <caseSize>72</caseSize>
//         <youth>false</youth>
//         <discountCode></discountCode>
//         <quantity>125</quantity>
//         <price>4.99</price>
//         <salePrice></salePrice>
//         <saleEndDate></saleEndDate>
//         <priceGroup>NR</priceGroup>
//       </Product>
//       ...
//     </ProductInventoryArray>
//     <ServiceMessageArray>...</ServiceMessageArray>
//   </GetBulkDataResponse>
//
// Each <Product> row is actually a VARIANT — grouped by `style` upstream
// of this module in the ingest job (suppliers/sanmar/ingest.js — #47).

const { soapCall } = require('../common/soap-client');
const { normaliseMessages, assertNoErrors } = require('../common/service-messages');

const NAMESPACE = 'https://edi.atc-apparel.com/bulk-data/';

/**
 * Pull the full catalog. Returns { variants, messages }.
 *
 * @param {object} config  From suppliers/sanmar/config.js loadConfig().
 * @returns {Promise<{ variants: object[], messages: object[] }>}
 */
async function getBulkData(config) {
  const { endpoints, credentials } = config;

  const response = await soapCall({
    endpoint:  endpoints.bulkData,
    namespace: NAMESPACE,
    operation: 'GetBulkData',
    body: {
      wsVersion: '1.0',
      id:        credentials.bulkDataId,
      password:  credentials.bulkDataPassword,
    },
  });

  const payload = response.GetBulkDataResponse || {};
  const messages = normaliseMessages(payload.ServiceMessageArray);

  // Tolerate sandbox info code 201; anything else throws.
  assertNoErrors(messages, { allowCodes: [201] });

  const inventoryArray = payload.ProductInventoryArray || {};
  const rawVariants = Array.isArray(inventoryArray.Product)
    ? inventoryArray.Product
    : inventoryArray.Product ? [inventoryArray.Product] : [];

  const variants = rawVariants.map(normaliseVariant);

  return { variants, messages };
}

// Normalise one <Product> row into a friendly shape. Strips empty strings
// to null, decodes HTML entities in French fields, coerces numerics.
function normaliseVariant(row) {
  return {
    supplierVariantId: toStr(row.productId),
    productName:       toStr(row.productName),
    frProductName:     decodeHtmlEntities(toStr(row.frProductName)),
    style:             toStr(row.style),
    size:              toStr(row.size),
    swatchColor:       toStr(row.swatchColor),
    frSwatchColor:     decodeHtmlEntities(toStr(row.frSwatchColor)),
    description:       toStr(row.description),
    frDescription:     decodeHtmlEntities(toStr(row.frDescription)),
    brand:             toStr(row.brand),
    imageUrl:          toStr(row.image),
    weight:            toNum(row.weight),
    caseSize:          toInt(row.caseSize),
    youth:             toBool(row.youth),
    discountCode:      toStr(row.discountCode),
    quantity:          toInt(row.quantity),
    price:             toNum(row.price),
    salePrice:         toNum(row.salePrice),
    saleEndDate:       toDate(row.saleEndDate),
    priceGroup:        toStr(row.priceGroup),
    _raw:              row,
  };
}

// ── coercion helpers ────────────────────────────────────────────────────

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

function toBool(v) {
  const s = toStr(v);
  if (s === null) return null;
  return s.toLowerCase() === 'true';
}

function toDate(v) {
  const s = toStr(v);
  if (!s) return null;
  // Accept YYYY-MM-DD; other formats pass through unchanged for logging.
  return /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : s;
}

// Minimal HTML entity decoder for the few SanMar uses in French text
// (&amp;eacute;, &amp;Eacute; — yes, doubly-escaped in the wire format).
function decodeHtmlEntities(s) {
  if (!s) return s;
  const map = {
    '&amp;':    '&',
    '&quot;':   '"',
    '&apos;':   "'",
    '&lt;':     '<',
    '&gt;':     '>',
    '&eacute;': 'é',
    '&Eacute;': 'É',
    '&egrave;': 'è',
    '&ecirc;':  'ê',
    '&agrave;': 'à',
    '&acirc;':  'â',
    '&ccedil;': 'ç',
    '&ocirc;':  'ô',
    '&ucirc;':  'û',
    '&icirc;':  'î',
    '&ugrave;': 'ù',
  };
  // Two passes handle SanMar's doubly-escaped sequences (&amp;eacute; → &eacute; → é).
  let out = s;
  for (let i = 0; i < 2; i++) {
    out = out.replace(/&[a-zA-Z]+;/g, (m) => map[m] ?? m);
  }
  return out;
}

module.exports = { getBulkData, normaliseVariant, decodeHtmlEntities };
