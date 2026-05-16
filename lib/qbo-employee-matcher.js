'use strict';

/**
 * QBO Employee Matcher
 *
 * Matches local employees to QuickBooks Online employees using:
 * - Exact name matching (95% confidence)
 * - Fuzzy name matching via Levenshtein distance (70-85%)
 * - Email domain matching (boost)
 * - First name + last name partial matches (60-75%)
 */

const { qbGet } = require('./qbo-sync');

/**
 * Levenshtein distance: minimum edit operations (insert, delete, replace)
 * to transform string a into string b. Lower = more similar.
 */
function levenshteinDistance(a, b) {
  const aLower = (a || '').toLowerCase().trim();
  const bLower = (b || '').toLowerCase().trim();
  const m = aLower.length;
  const n = bLower.length;

  const dp = Array(m + 1).fill(0).map(() => Array(n + 1).fill(0));

  for (let i = 0; i <= m; i++) dp[i][0] = i;
  for (let j = 0; j <= n; j++) dp[0][j] = j;

  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      const cost = aLower[i - 1] === bLower[j - 1] ? 0 : 1;
      dp[i][j] = Math.min(
        dp[i - 1][j] + 1,     // deletion
        dp[i][j - 1] + 1,     // insertion
        dp[i - 1][j - 1] + cost // substitution
      );
    }
  }
  return dp[m][n];
}

/**
 * Similarity score: 0–1 scale (1 = perfect match, 0 = completely different).
 * Uses max length so shorter strings don't trivially match.
 */
function nameSimilarity(a, b) {
  const maxLen = Math.max((a || '').length, (b || '').length);
  if (maxLen === 0) return 1; // both empty
  const dist = levenshteinDistance(a, b);
  return Math.max(0, 1 - (dist / maxLen));
}

/**
 * Parse "FirstName LastName" into components.
 * Returns { first, last, full }
 */
function parseName(fullName) {
  if (!fullName) return { first: '', last: '', full: '' };
  const trimmed = fullName.trim();
  const parts = trimmed.split(/\s+/);
  return {
    first: parts[0] || '',
    last: parts.slice(1).join(' ') || '',
    full: trimmed,
  };
}

/**
 * Score a single QBO employee candidate against a local employee.
 * Returns { qboEmployeeId, confidence, reason, qboName, qboEmail }
 */
function scoreCandidate(localEmployee, qboEmployee) {
  const localName = parseName(
    `${localEmployee.first_name || ''} ${localEmployee.last_name || ''}`.trim()
  );
  const qboName = parseName(qboEmployee.DisplayName);

  let confidence = 0;
  let reasons = [];

  // ─── Exact full name match: 95% ────────────────────────────────────────
  if (localName.full.toLowerCase() === qboName.full.toLowerCase()) {
    confidence = 0.95;
    reasons.push('exact_full_name');
  }
  // ─── First + Last name exact match: 92% ────────────────────────────────
  else if (
    localName.first.toLowerCase() === qboName.first.toLowerCase() &&
    localName.last.toLowerCase() === qboName.last.toLowerCase() &&
    localName.first && localName.last
  ) {
    confidence = 0.92;
    reasons.push('exact_first_last');
  }
  // ─── Fuzzy full name: 60–85% based on similarity ──────────────────────
  else {
    const sim = nameSimilarity(localName.full, qboName.full);
    if (sim >= 0.80) {
      confidence = 0.82;
      reasons.push('fuzzy_full_match');
    } else if (sim >= 0.65) {
      confidence = 0.70;
      reasons.push('fuzzy_partial_match');
    } else {
      confidence = Math.max(0, sim * 0.5); // scale down for very low scores
      reasons.push('low_similarity');
    }
  }

  // ─── Email domain match: +5% boost ────────────────────────────────────
  if (confidence > 0 && localEmployee.email && qboEmployee.PrimaryEmailAddr?.Address) {
    const localDomain = localEmployee.email.split('@')[1];
    const qboDomain = qboEmployee.PrimaryEmailAddr.Address.split('@')[1];
    if (localDomain && qboDomain && localDomain === qboDomain) {
      confidence = Math.min(0.99, confidence + 0.05);
      reasons.push('email_domain_match');
    }
  }

  // ─── First name only match (if full match failed): 60% ─────────────────
  if (
    confidence < 0.60 &&
    localName.first &&
    qboName.first &&
    localName.first.toLowerCase() === qboName.first.toLowerCase()
  ) {
    confidence = 0.60;
    reasons.push('first_name_only');
  }

  return {
    qbo_employee_id: qboEmployee.Id,
    qbo_display_name: qboEmployee.DisplayName,
    qbo_email: qboEmployee.PrimaryEmailAddr?.Address || null,
    confidence: Math.round(confidence * 100) / 100, // round to 2 decimals
    match_reason: reasons.join(', '),
  };
}

/**
 * Main matching function: find QBO candidates for a single local employee.
 * Returns array of candidates sorted by confidence (descending).
 * Filters to top 5 candidates.
 */
async function findCandidatesForEmployee(localEmployee, qboEmployees) {
  if (!qboEmployees || qboEmployees.length === 0) {
    return [];
  }

  const candidates = qboEmployees
    .map(qbo => scoreCandidate(localEmployee, qbo))
    .filter(c => c.confidence >= 0.50) // only return matches >50% confidence
    .sort((a, b) => b.confidence - a.confidence) // highest confidence first
    .slice(0, 5); // top 5

  return candidates;
}

/**
 * Run the full matching engine:
 * 1. Fetch all active QBO employees
 * 2. For each unmapped local employee, find top candidates
 * 3. Return results grouped by confidence level (auto-match, review, unmapped)
 *
 * Returns:
 * {
 *   auto_matches: [{ local_id, local_name, qbo_id, qbo_name, confidence }],
 *   review_matches: [{ local_id, local_name, candidates: [...] }],
 *   unmapped: [{ local_id, local_name, reason: 'no_candidates' }],
 *   total_qbo_employees: number,
 *   total_local_unmatched: number,
 * }
 */
async function matchEmployees(localEmployees) {
  // Fetch all active QBO employees
  let qboEmployees = [];
  try {
    const data = await qbGet(
      `/query?query=${encodeURIComponent(
        `SELECT * FROM Employee WHERE Active = true MAXRESULTS 200`
      )}`
    );
    qboEmployees = data?.QueryResponse?.Employee || [];
  } catch (err) {
    console.error('Failed to fetch QBO employees:', err.message);
    throw new Error(`QBO fetch failed: ${err.message}`);
  }

  const autoMatches = [];
  const reviewMatches = [];
  const unmapped = [];

  for (const emp of localEmployees) {
    // Skip already-mapped employees
    if (emp.qbo_employee_id) {
      continue;
    }

    const candidates = await findCandidatesForEmployee(emp, qboEmployees);

    if (candidates.length === 0) {
      unmapped.push({
        local_id: emp.id,
        local_name: `${emp.first_name || ''} ${emp.last_name || ''}`.trim(),
        reason: 'no_candidates',
      });
    } else if (candidates.length === 1 && candidates[0].confidence >= 0.85) {
      // High-confidence single match: auto-match
      autoMatches.push({
        local_id: emp.id,
        local_name: `${emp.first_name || ''} ${emp.last_name || ''}`.trim(),
        qbo_employee_id: candidates[0].qbo_employee_id,
        qbo_display_name: candidates[0].qbo_display_name,
        confidence: candidates[0].confidence,
        match_reason: candidates[0].match_reason,
      });
    } else {
      // Multiple candidates or moderate confidence: needs review
      reviewMatches.push({
        local_id: emp.id,
        local_name: `${emp.first_name || ''} ${emp.last_name || ''}`.trim(),
        local_email: emp.email || null,
        candidates,
      });
    }
  }

  return {
    auto_matches: autoMatches,
    review_matches: reviewMatches,
    unmapped,
    total_qbo_employees: qboEmployees.length,
    total_local_unmatched: localEmployees.filter(e => !e.qbo_employee_id).length,
  };
}

module.exports = {
  levenshteinDistance,
  nameSimilarity,
  parseName,
  scoreCandidate,
  findCandidatesForEmployee,
  matchEmployees,
};
