// lib/phone.js
// Phone-number normalization for caller-ID matching.
//
// One rule everywhere: a number is either a valid E.164 string, or it is
// nothing. Half-parsed junk must never reach client_phone_index, because a
// bad index row silently pops the WRONG customer's card at the wrong moment,
// which is worse than no pop at all.
//
// Default region is CA — the shop is in Walkerton ON and effectively every
// stored number is NANP. libphonenumber-js validates the area code and
// length, so '0000000000', 'N/A', and '555-1234' are rejected rather than
// being turned into a plausible-looking +10000000000.
//
// Note: lib/sms.js has its own lighter toE164(). It predates this file and is
// used for OUTBOUND destination formatting where a permissive parse is fine
// (worst case the send fails). Matching is the opposite problem — be strict.

'use strict';

const { parsePhoneNumberFromString } = require('libphonenumber-js');

const DEFAULT_REGION = 'CA';

// Return '+15198891343' or null. Never throws.
//
// Accepts anything the shop has ever stored or a phone has ever sent:
//   '(519) 889-1343'   → +15198891343
//   '15198891343'      → +15198891343   ← the raw inbound caller-ID format
//   '519-889-1343 x2'  → +15198891343   (extension is dropped, not an error)
//   ''  / 'N/A' / null → null
function toE164(raw, region = DEFAULT_REGION) {
  if (raw === null || raw === undefined) return null;
  const s = String(raw).trim();
  if (!s) return null;

  // Internal extension dial ('104'), not a phone number. Bail before
  // libphonenumber gets creative about a 3-digit string.
  if (/^\d{1,6}$/.test(s)) return null;

  let parsed = null;
  try {
    parsed = parsePhoneNumberFromString(s, region);
  } catch {
    return null;
  }
  if (!parsed || !parsed.isValid()) return null;
  return parsed.number;
}

// Human-readable form for the screen pop: '(519) 889-1343' for NANP,
// international format otherwise. Falls back to the raw string so an
// unparseable number still renders as *something* the staffer can read
// off the screen.
function formatForDisplay(raw, region = DEFAULT_REGION) {
  if (raw === null || raw === undefined) return '';
  const s = String(raw).trim();
  if (!s) return '';
  let parsed = null;
  try {
    parsed = parsePhoneNumberFromString(s, region);
  } catch {
    return s;
  }
  if (!parsed || !parsed.isValid()) return s;
  return parsed.country === 'CA' || parsed.country === 'US'
    ? parsed.formatNational()
    : parsed.formatInternational();
}

// Is this string an internal extension rather than an outside number?
// Extension-to-extension calls arrive as $remote='104'. They still get logged
// (useful for "who called the front desk"), but they never match a client and
// never pop a customer card.
function isInternalExtension(raw) {
  if (raw === null || raw === undefined) return false;
  return /^\d{1,6}$/.test(String(raw).trim());
}

// Caller ID withheld. The phone sends an empty string, or literal text that
// varies by carrier. Also catches the "unsupported $variable arrived as
// literal text" case from the Action URL — anything starting with '$' was a
// dynamic variable the firmware didn't recognise.
function isAnonymous(raw) {
  if (raw === null || raw === undefined) return true;
  const s = String(raw).trim();
  if (!s) return true;
  if (s.startsWith('$')) return true;
  return /^(anonymous|unknown|private|restricted|unavailable|blocked)$/i.test(s);
}

module.exports = { toE164, formatForDisplay, isInternalExtension, isAnonymous, DEFAULT_REGION };
