// suppliers/promostandards/media-content.js
//
// PromoStandards Media Content 1.2.0 client.
// Spec: https://tools.promostandards.org/standards/services
//
// Operations:
//   - getMediaContent           — image / video URLs for a productId.
//   - getMediaDateModified      — delta ingest.  [stubbed]
//
// v1.2.0 response shape notes:
//   - One <MediaContent> element per URL. (v1.1 crammed multiple URLs into
//     whitespace-separated text inside a single <url>, which forced
//     post-parse splitting. v1.2 fixes this.)
//   - <color> is a scalar colour name. No hex field exists anywhere in the
//     1.2 schema — suppliers that need hex must bring their own mapping.
//   - `classType` lives under <ClassTypeArray><ClassType><classTypeId>…
//     as a numeric ID. Known IDs:
//         1001 Primary   1002 Secondary  1003 Swatch
//         1004 Logo      1005 Catalog    1006 Specification
//   - The file-kind field is `fileType` (Image | Video | Audio | …),
//     replacing v1.1's `mediaType`. We fall back to `mediaType` for
//     adapters still serving the old shape.
//
// Note: this service typically uses its OWN password (distinct from
// Product Data). Supplier adapters surface it as credentials.mediaPassword.

const { soapCall } = require('../common/soap-client');
const { normaliseMessages, assertNoErrors } = require('../common/service-messages');

const NAMESPACE  = 'http://www.promostandards.org/WSDL/MediaService/1.2.0/';
const WS_VERSION = '1.2.0';

// Numeric classTypeId → human name. Covers the standard 1.2 enumeration.
const CLASS_TYPE_ID_TO_NAME = {
  '1001': 'Primary',
  '1002': 'Secondary',
  '1003': 'Swatch',
  '1004': 'Logo',
  '1005': 'Catalog',
  '1006': 'Specification',
};

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
    // v1.2 → fileType; v1.1 → mediaType. Accept both.
    mediaType:   toStr(m.fileType) || toStr(m.mediaType),
    classType:   extractClassType(m),
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

// classType in v1.2 is a numeric id nested under ClassTypeArray.ClassType.
// v1.1 returned a string at m.classType. We handle both, always resolving
// to a human name where possible.
function extractClassType(m) {
  if (!m) return null;
  const direct = toStr(m.classType);
  if (direct) {
    return CLASS_TYPE_ID_TO_NAME[direct] || direct;
  }
  const cta = m.ClassTypeArray;
  if (cta) {
    const ct = cta.ClassType ?? cta.classType ?? cta;
    const list = Array.isArray(ct) ? ct : [ct];
    for (const c of list) {
      if (!c) continue;
      const name = toStr(c.classTypeName);
      if (name) return name;
      const id = toStr(c.classTypeId);
      if (id) return CLASS_TYPE_ID_TO_NAME[id] || id;
    }
  }
  return null;
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
// be inlined as a scalar `color` field. v1.2 standardises on a scalar
// `color` element; older adapters still vary.
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

// Hex is NOT in the 1.2 spec, but we still look for it defensively — some
// adapters ship a custom extension. Everything that comes back here is
// ultimately supplemented by suppliers/sanmar/color-hex-map.js.
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

module.exports = {
  NAMESPACE,
  WS_VERSION,
  CLASS_TYPE_ID_TO_NAME,
  getMediaContent,
  getMediaDateModified,
};
