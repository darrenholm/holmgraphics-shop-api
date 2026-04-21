// suppliers/common/soap-client.js
//
// Generic PromoStandards SOAP 1.1 client.
//
// Every PromoStandards service follows the same envelope shape: HTTP POST
// with a SOAP envelope containing a single request element in a
// service-specific namespace, receiving an envelope back with the response
// element and a ServiceMessageArray. This module does the transport + XML
// marshalling so per-service modules can focus on field mapping.
//
// Non-PromoStandards services (e.g. SanMar's Bulk Data) also work with
// this module — just pass their namespace and operation name.
//
// Requires Node 18+ for global fetch / AbortSignal.timeout.

const { XMLParser, XMLBuilder } = require('fast-xml-parser');

// Tags we always want as arrays in parsed output — even if only one
// element is present. Prevents brittle "is it an object or array?" checks
// in per-service code.
const ALWAYS_ARRAY = new Set([
  'Product',
  'ProductPart',
  'PartArray',
  'PartInventoryArray',
  'InventoryLocationArray',
  'PartPriceArray',
  'Price',
  'ProductPartArray',
  'ServiceMessage',
  'Location',
  'MediaItem',
  'MediaContent',
  'Configuration',
  'FobPoint',
]);

const PARSER_OPTIONS = {
  ignoreAttributes: true,
  removeNSPrefix:   true,   // <ns1:Product> → <Product>
  parseTagValue:    true,
  trimValues:       true,
  isArray: (tagName /* , jPath */) => ALWAYS_ARRAY.has(tagName),
};

const BUILDER_OPTIONS = {
  ignoreAttributes:  false,
  suppressEmptyNode: false,
  format:            false,  // compact on the wire
};

// Recursively prefix every object key with `ns:`.
// Attribute keys (@_xmlns:ns, etc.) are left alone.
function prefixKeys(value, prefix) {
  if (value === null || value === undefined) return value;
  if (Array.isArray(value)) return value.map((v) => prefixKeys(v, prefix));
  if (typeof value !== 'object') return value;

  const out = {};
  for (const [k, v] of Object.entries(value)) {
    if (k.startsWith('@_') || k.startsWith('#')) {
      out[k] = v;
    } else {
      out[`${prefix}:${k}`] = prefixKeys(v, prefix);
    }
  }
  return out;
}

function buildEnvelope({ namespace, operation, body }) {
  const builder = new XMLBuilder(BUILDER_OPTIONS);
  const requestBody = {
    [`ns:${operation}Request`]: {
      '@_xmlns:ns': namespace,
      ...prefixKeys(body, 'ns'),
    },
  };
  const bodyXml = builder.build(requestBody);

  return (
    '<?xml version="1.0" encoding="UTF-8"?>' +
    '<soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/">' +
      '<soapenv:Header/>' +
      '<soapenv:Body>' + bodyXml + '</soapenv:Body>' +
    '</soapenv:Envelope>'
  );
}

function parseEnvelope(xml) {
  const parser = new XMLParser(PARSER_OPTIONS);
  const parsed = parser.parse(xml);
  // After removeNSPrefix, top-level is <Envelope> (or sometimes naked).
  const envelope = parsed.Envelope || parsed;
  return envelope.Body || envelope;
}

function truncate(s, n) {
  return typeof s === 'string' && s.length > n ? s.slice(0, n) + '…[truncated]' : s;
}

/**
 * Make a SOAP call against a PromoStandards (or PromoStandards-shaped) endpoint.
 *
 * @param {object}  opts
 * @param {string}  opts.endpoint    Full URL to the service endpoint.
 * @param {string}  opts.namespace   XML namespace for the operation request.
 * @param {string}  opts.operation   e.g. 'GetProduct'. Becomes `<ns:GetProductRequest>`.
 * @param {object}  opts.body        Plain object — children of the Request element.
 *                                   Keys must match spec field names (e.g. wsVersion, id).
 * @param {string=} opts.soapAction  Optional SOAPAction header value. Default "".
 * @param {number=} opts.timeoutMs   Default 30000.
 * @returns {Promise<object>}        Parsed response body (namespace-stripped).
 */
async function soapCall({
  endpoint,
  namespace,
  operation,
  body,
  soapAction = '',
  timeoutMs = 30000,
}) {
  if (!endpoint)  throw new Error('soapCall: endpoint required');
  if (!namespace) throw new Error('soapCall: namespace required');
  if (!operation) throw new Error('soapCall: operation required');

  const envelope = buildEnvelope({ namespace, operation, body: body || {} });

  let res;
  try {
    res = await fetch(endpoint, {
      method:  'POST',
      headers: {
        'Content-Type': 'text/xml; charset=utf-8',
        'SOAPAction':   `"${soapAction}"`,
      },
      body:    envelope,
      signal:  AbortSignal.timeout(timeoutMs),
    });
  } catch (e) {
    throw new Error(`SOAP transport error calling ${operation} at ${endpoint}: ${e.message}`);
  }

  const text = await res.text();

  if (!res.ok) {
    throw new Error(
      `SOAP HTTP ${res.status} from ${operation} at ${endpoint}: ${truncate(text, 500)}`
    );
  }

  const parsed = parseEnvelope(text);

  // SOAP Fault detection
  if (parsed.Fault) {
    const code   = parsed.Fault.faultcode   || 'unknown';
    const reason = parsed.Fault.faultstring || JSON.stringify(parsed.Fault);
    throw new Error(`SOAP Fault ${code} on ${operation}: ${reason}`);
  }

  return parsed;
}

module.exports = { soapCall, buildEnvelope, parseEnvelope, prefixKeys };
