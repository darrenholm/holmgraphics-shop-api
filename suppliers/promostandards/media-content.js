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
    partId:      toStr(m.productPartId) || toStr(m.partId),
    color:       toStr(m.color?.colorName) || toStr(m.colorName),
    size:        toStr(m.size?.apparelSize) || toStr(m.size),
    description: toStr(m.description),
    _raw:        m,
  }));

  return { productId, items, messages };
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
