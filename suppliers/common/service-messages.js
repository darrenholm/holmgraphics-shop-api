// suppliers/common/service-messages.js
//
// Standard PromoStandards ServiceMessage handling.
//
// Every PS response includes a ServiceMessageArray with at least one
// ServiceMessage — code 200 on success, various codes on trouble. This
// module gives per-service clients one place to normalise that handling.
//
// Codes are drawn from the PromoStandards Error Code documentation and
// SanMar's integration guide. Not every supplier uses every code; unknown
// codes fall back to "unknown-error" severity.

const CODES = {
  // ── Success / informational ────────────────────────────────────────
  200: { severity: 'ok',    label: 'Success' },
  201: { severity: 'info',  label: 'Sandbox mode — sample data returned' },

  // ── Authentication (credentials wrong / missing) ───────────────────
  100: { severity: 'error', label: 'Authentication — username invalid' },
  105: { severity: 'error', label: 'Authentication — password invalid' },
  110: { severity: 'error', label: 'Authentication — credentials missing' },

  // ── Authorisation (credentials OK but not allowed) ─────────────────
  115: { severity: 'error', label: 'Authorisation — access denied for this service' },
  120: { severity: 'error', label: 'Authorisation — IP not whitelisted' },
  125: { severity: 'error', label: 'Authorisation — account inactive' },

  // ── Request shape / required fields ────────────────────────────────
  130: { severity: 'error', label: 'Request — required field missing or invalid' },
  300: { severity: 'error', label: 'Request — malformed or unsupported filter' },

  // ── Temporary / upstream ───────────────────────────────────────────
  400: { severity: 'error', label: 'Temporary — supplier service unavailable' },
  500: { severity: 'error', label: 'Unspecified server error' },

  // ── Data lookups ───────────────────────────────────────────────────
  600: { severity: 'error', label: 'Data — product ID not found' },
  610: { severity: 'error', label: 'Data — style not found' },
  620: { severity: 'error', label: 'Data — part group not found' },
  630: { severity: 'error', label: 'Data — part (variant) not found' },
  640: { severity: 'error', label: 'Data — no inventory for specified criteria' },

  // ── Result set bounds ──────────────────────────────────────────────
  700: { severity: 'error', label: 'Too many records returned — refine query' },
};

/**
 * Normalise a parsed ServiceMessageArray block.
 * Accepts either an object (single message) or array (multiple).
 * Always returns an array of { code, severity, label, description }.
 */
function normaliseMessages(block) {
  if (!block) return [];
  const raw = block.ServiceMessage || block;
  const arr = Array.isArray(raw) ? raw : [raw];

  return arr
    .filter(Boolean)
    .map((m) => {
      const code = Number(m.code);
      const spec = CODES[code] || { severity: 'unknown-error', label: `Code ${code}` };
      return {
        code,
        severity:    spec.severity,
        label:       spec.label,
        description: m.description || '',
        raw:         m,
      };
    });
}

/**
 * Throw if any message indicates an error, unless its code is in
 * `allowCodes` (e.g. [201] to tolerate sandbox-mode info messages,
 * or [600, 630] if a "not found" is expected in your flow).
 */
function assertNoErrors(messages, { allowCodes = [201] } = {}) {
  const allow = new Set(allowCodes);
  const bad = messages.filter(
    (m) => (m.severity === 'error' || m.severity === 'unknown-error') && !allow.has(m.code)
  );
  if (bad.length === 0) return;

  const detail = bad
    .map((m) => `[${m.code}] ${m.label}${m.description ? ' — ' + m.description : ''}`)
    .join('; ');
  const err = new Error(`PromoStandards service error: ${detail}`);
  err.serviceMessages = bad;
  throw err;
}

module.exports = { CODES, normaliseMessages, assertNoErrors };
