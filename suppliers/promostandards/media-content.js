// suppliers/promostandards/media-content.js
//
// PromoStandards Media Content 1.1.0 client.
// Spec: https://tools.promostandards.org/standards/services
//
// Operations:
//   - getMediaContent           — image / video URLs for a productId.
//   - getMediaDateModified      — delta ingest.  [stubbed]
//
// Note: this service typically uses its OWN password (distinct from
// Product Data). Supplier adapters surface it as credentials.mediaPassword.

const { soapCall } = require('../common/soap-client');
const { normaliseMessages, assertNoErrors } = require('../common/service-messages');

const NAMESPACE  = 'http://www.promostandards.org/WSDL/MediaService/1.1.0/';
const WS_VERSION = '1.1.0';

/**
 * getMediaContent — images / videos / spec sheets for a product.
 *
 * @param {object} config
 * @param {object} args
 * @param {string} args.productId        required
 * @param {string=} args.mediaType       'Image' | 'Video' | 'Logo' | 'Catalog' (optional filter)
 * @param {string=} args.classType       'Primary' | 'Swatch' | 'Secondary' (optional filter)
 * @param {string=} args.cultureName     e.g. 'en-CA' (optional)
 */
async function getMediaContent(config, args) {
  const { productId, mediaType, classType, cultureName } = args || {};
  if (!productId) throw new Error('getMediaContent: productId required');

  const body = {
    wsVersion: WS_VERSION,
    id:        config.credentials.id,
    password:  config.credentials.mediaPassword || config.credentials.password,
    productId,
  };
  if (mediaType)   body.mediaType   = mediaType;
  if (classType)   body.classType   = classType;
  if (cultureName) body.cultureName = cultureName;

  const response = await soapCall({
    endpoint:  config.endpoints.mediaContent,
    namespace: NAMESPACE,
    operation: 'GetMediaContent',
    body,
  });

  const payload  = response.GetMediaContentResponse || {};
  const messages = normaliseMessages(payload.ServiceMessageArray);
  assertNoErrors(messages, { allowCodes: [201] });

  const raw = payload.MediaContentArray?.MediaContent
           ?? payload.MediaContent
           ?? [];
  const list = Array.isArray(raw) ? raw : [raw];
  const items = list.map((m) => ({
    url:         toStr(m.url),
    mediaType:   toStr(m.mediaType),
    classType:   toStr(m.classType),
    // partId may live at top-level, under ProductPartArray.ProductPart[].partId,
    // or (rarely) as productPartId. Collect all that apply.
    partId:      toStr(m.productPartId) || toStr(m.partId) || extractPartIds(m)[0] || null,
    partIds:     extractPartIds(m),
    color:       extractColorName(m),
    colorHex:    extractColorHex(m),
    size:        toStr(m.size?.apparelSize) || toStr(m.size),
    description: toStr(m.description),
    fileName:    toStr(m.fileName),
    _raw:        m,
  }));

  return { productId, items, messages };
}

// A MediaContent item may associate with one or more ProductParts. Return
// every partId we can find.
function extractPartIds(m) {
  const ids = new Set();
  const ppa = m?.ProductPartArray;
  if (ppa) {
    const parts = ppa.ProductPart ?? ppa.productPart ?? ppa;
    const list = Array.isArray(parts) ? parts : [parts];
    for (const p of list) {
      if (!p) continue;
      const id = toStr(p.partId ?? p.PartId ?? p.productPartId);
      if (id) ids.add(id);
    }
  }
  const flat = toStr(m?.partId) || toStr(m?.productPartId);
  if (flat) ids.add(flat);
  return [...ids];
}

// Colour name might hang off Color/colorName/SwatchColor/swatchColor — or
// be inlined as a scalar `color` field.
function extractColorName(m) {
  if (!m) return null;
  return (
    toStr(m.color?.colorName) ||
    toStr(m.Color?.colorName) ||
    toStr(m.color?.name)      ||
    toStr(m.Color?.name)      ||
    toStr(m.SwatchColor?.colorName) ||
    toStr(m.swatchColor?.colorName) ||
    toStr(m.colorName)        ||
    toStr(m.swatchColor)      ||
    toStr(m.color)            ||
    null
  );
}

// Hex may live at m.Color.hex, m.color.hex, m.hex, m.SwatchHex, etc. Accept
// with/without leading # and normalise to upper-case 6-char form.
function extractColorHex(m) {
  if (!m) return null;
  const candidate =
    m.color?.hex ??
    m.Color?.hex ??
    m.color?.colorHex ??
    m.Color?.colorHex ??
    m.SwatchColor?.hex ??
    m.swatchColor?.hex ??
    m.SwatchHex ??
    m.swatchHex ??
    m.hex ??
    null;
  return normaliseHex(candidate);
}

function normaliseHex(v) {
  if (v === undefined || v === null) return null;
  let s = String(v).trim();
  if (!s) return null;
  if (s.startsWith('#')) s = s.slice(1);
  if (!/^[0-9a-fA-F]{3,8}$/.test(s)) return null;
  if (s.length === 3) {
    s = s.split('').map((c) => c + c).join('');  // abc → aabbcc
  }
  if (s.length === 8) s = s.slice(0, 6);          // strip alpha
  if (s.length !== 6) return null;
  return '#' + s.toUpperCase();
}

async function getMediaDateModified(_config, _args) {
  throw new Error('getMediaDateModified not yet implemented');
}

function toStr(v) {
  if (v === undefined || v === null) return null;
  const s = String(v).trim();
  return s === '' ? null : s;
}

module.exports = { NAMESPACE, getMediaContent, getMediaDateModified };
