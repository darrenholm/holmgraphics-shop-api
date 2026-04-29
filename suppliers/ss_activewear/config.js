// suppliers/ss_activewear/config.js
//
// S&S Activewear Canada — REST adapter config.
//
// Loads credentials from SSACTIVEWEAR_ACCOUNT_NUMBER + SSACTIVEWEAR_API_KEY
// (HTTP Basic). Throws at load time if either is missing — every code path
// that would call S&S needs both, so failing fast beats producing 401s
// halfway through an ingest.
//
// (We previously had a SOAP/PromoStandards stub here for an integration S&S
// never actually offered. This file replaces it with the REST credentials
// the live API expects. If they ever publish PromoStandards, we'd add a
// separate file rather than overload this one.)

'use strict';

const BASE_URL = 'https://api-ca.ssactivewear.com';
const IMAGE_BASE_URL = 'https://cdn.ssactivewear.com';   // .com CDN serves .ca images too

function loadConfig() {
  const account = process.env.SSACTIVEWEAR_ACCOUNT_NUMBER;
  const apiKey  = process.env.SSACTIVEWEAR_API_KEY;
  if (!account || !apiKey) {
    throw new Error(
      'SSACTIVEWEAR_ACCOUNT_NUMBER and SSACTIVEWEAR_API_KEY must be set ' +
      '(HTTP Basic auth for api-ca.ssactivewear.com/V2/)'
    );
  }
  return {
    supplierCode:  'ss_activewear_ca',
    baseUrl:       BASE_URL,
    imageBaseUrl:  IMAGE_BASE_URL,
    credentials:   { account, apiKey },
  };
}

module.exports = { BASE_URL, IMAGE_BASE_URL, loadConfig };
