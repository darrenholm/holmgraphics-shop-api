'use strict';

/**
 * routes/qbo-employee-match.js
 *
 * QBO employee matching endpoints for the admin reconciliation workflow.
 *
 * Endpoints:
 *   POST /api/qbo-match/match-employees          Run the matcher engine
 *   GET  /api/qbo-match/pending-matches          Get unreviewed candidates
 *   POST /api/qbo-match/confirm-match            Confirm a match + link employee
 */

const express = require('express');
const { pool, query, queryOne } = require('../db/connection');
const { requireAdmin } = require('../middleware/auth');
const { matchEmployees } = require('../lib/qbo-employee-matcher');

const router = express.Router();

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/qbo-match/match-employees
// ─────────────────────────────────────────────────────────────────────────────
// Run the matcher against all unmapped local employees.
// This is a potentially long-running operation (fetches QBO, runs fuzzy matching).
//
// Returns:
// {
//   auto_matches: [
//     { local_id, local_name, qbo_employee_id, qbo_display_name, confidence, match_reason }
//   ],
//   review_matches: [
//     { local_id, local_name, local_email, candidates: [...] }
//   ],
//   unmapped: [{ local_id, local_name, reason }],
//   total_qbo_employees,
//   total_local_unmatched,
//   auto_linked: int (count of high-confidence auto-matches we linked immediately)
// }

router.post('/match-employees', requireAdmin, async (req, res) => {
  const client = await pool.connect();
  try {
    // Fetch all local employees who don't yet have a QBO mapping
    const unmappedLocals = await query(
      `SELECT id, first_name, last_name, email, qbo_employee_id
         FROM employees
        WHERE qbo_employee_id IS NULL
        ORDER BY first_name, last_name`
    );

    if (unmappedLocals.length === 0) {
      return res.json({
        message: 'All employees are already mapped to QBO.',
        auto_matches: [],
        review_matches: [],
        unmapped: [],
        total_qbo_employees: 0,
        total_local_unmatched: 0,
        auto_linked: 0,
      });
    }

    // Run the matching engine
    const results = await matchEmployees(unmappedLocals);

    // Clear out old candidates for these employees (fresh run)
    const localIds = unmappedLocals.map(e => e.id);
    await query(
      `DELETE FROM employee_match_candidates
        WHERE local_employee_id = ANY($1::int[])`,
      [localIds]
    );

    // Insert new candidates from this run (both auto and review matches)
    const allCandidates = [
      ...results.auto_matches.map(m => ({
        local_employee_id: m.local_id,
        qbo_employee_id: m.qbo_employee_id,
        match_confidence: m.confidence,
        match_reason: m.match_reason,
        user_reviewed: true,
        user_confirmed: true,
      })),
      ...results.review_matches.flatMap(r =>
        r.candidates.map(c => ({
          local_employee_id: r.local_id,
          qbo_employee_id: c.qbo_employee_id,
          match_confidence: c.confidence,
          match_reason: c.match_reason,
          user_reviewed: false,
          user_confirmed: false,
        }))
      ),
    ];

    // Batch insert candidates
    if (allCandidates.length > 0) {
      const placeholders = allCandidates
        .map((_, i) => {
          const base = i * 6;
          return `($${base + 1}, $${base + 2}, $${base + 3}, $${base + 4}, $${base + 5}, $${base + 6})`;
        })
        .join(',');
      const flatParams = allCandidates.flatMap(c => [
        c.local_employee_id,
        c.qbo_employee_id,
        c.match_confidence,
        c.match_reason,
        c.user_reviewed,
        c.user_confirmed,
      ]);
      await query(
        `INSERT INTO employee_match_candidates
          (local_employee_id, qbo_employee_id, match_confidence, match_reason, user_reviewed, user_confirmed)
         VALUES ${placeholders}`,
        flatParams
      );
    }

    // For auto-matches (high confidence), immediately link them to employees.qbo_employee_id
    // so they don't need manual confirmation. Mark as confirmed in the candidates table too.
    let autoLinked = 0;
    if (results.auto_matches.length > 0) {
      const autoMatchIds = results.auto_matches.map(m => m.local_id);
      const autoMatchMap = new Map(
        results.auto_matches.map(m => [m.local_id, m.qbo_employee_id])
      );
      // Bulk update employees table
      for (const [localId, qboId] of autoMatchMap) {
        await query(
          `UPDATE employees SET qbo_employee_id = $1 WHERE id = $2`,
          [qboId, localId]
        );
      }
      autoLinked = results.auto_matches.length;
      // The candidates table already has user_confirmed=true from the insert above
    }

    res.json({
      ...results,
      auto_linked: autoLinked,
      message:
        autoLinked > 0
          ? `${autoLinked} employee(s) auto-linked. ${results.review_matches.length} require review.`
          : `${results.review_matches.length} match(es) need review. ${results.unmapped.length} have no candidates.`,
    });
  } catch (err) {
    console.error('POST /qbo-match/match-employees failed:', err);
    res.status(500).json({ error: err.message, detail: err.message });
  } finally {
    client.release();
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/qbo-match/pending-matches
// ─────────────────────────────────────────────────────────────────────────────
// Fetch all unreviewed/unconfirmed match candidates for the admin UI.
//
// Returns:
// [
//   {
//     local_id,
//     local_name,
//     local_email,
//     candidates: [
//       { qbo_employee_id, qbo_display_name, qbo_email, confidence, match_reason }
//     ]
//   }
// ]

router.get('/pending-matches', requireAdmin, async (req, res) => {
  try {
    const rows = await query(`
      SELECT
        e.id AS local_id,
        TRIM(CONCAT_WS(' ', e.first_name, e.last_name)) AS local_name,
        e.email AS local_email,
        c.qbo_employee_id,
        c.match_confidence,
        c.match_reason
      FROM employee_match_candidates c
      JOIN employees e ON e.id = c.local_employee_id
      WHERE c.user_reviewed = FALSE AND c.user_confirmed = FALSE
      ORDER BY e.first_name, e.last_name, c.match_confidence DESC
    `);

    // Group by local employee
    const grouped = new Map();
    for (const row of rows) {
      if (!grouped.has(row.local_id)) {
        grouped.set(row.local_id, {
          local_id: row.local_id,
          local_name: row.local_name,
          local_email: row.local_email,
          candidates: [],
        });
      }
      grouped.get(row.local_id).candidates.push({
        qbo_employee_id: row.qbo_employee_id,
        confidence: row.match_confidence,
        match_reason: row.match_reason,
      });
    }

    res.json(Array.from(grouped.values()));
  } catch (err) {
    console.error('GET /qbo-match/pending-matches failed:', err);
    res.status(500).json({ error: err.message });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/qbo-match/confirm-match
// ─────────────────────────────────────────────────────────────────────────────
// Admin confirms a match: updates employees.qbo_employee_id and marks the
// candidate as confirmed.
//
// Body: { local_employee_id, qbo_employee_id }
//
// Returns: { success, local_id, qbo_employee_id, message }

router.post('/confirm-match', requireAdmin, async (req, res) => {
  const { local_employee_id, qbo_employee_id } = req.body;

  if (!Number.isInteger(local_employee_id) || typeof qbo_employee_id !== 'string') {
    return res.status(400).json({
      error: 'local_employee_id (int) and qbo_employee_id (string) required',
    });
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Verify the local employee exists and isn't already mapped
    const emp = await client.query(
      `SELECT id, qbo_employee_id FROM employees WHERE id = $1`,
      [local_employee_id]
    );
    if (emp.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Employee not found' });
    }
    if (emp.rows[0].qbo_employee_id) {
      await client.query('ROLLBACK');
      return res.status(409).json({
        error: `Employee already linked to QBO ID ${emp.rows[0].qbo_employee_id}`,
      });
    }

    // Verify the candidate exists (optional safety check)
    const cand = await client.query(
      `SELECT id FROM employee_match_candidates
        WHERE local_employee_id = $1 AND qbo_employee_id = $2`,
      [local_employee_id, qbo_employee_id]
    );
    if (cand.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(400).json({
        error: `No match candidate found for this local+QBO employee pair`,
      });
    }

    // Update employees table: link the QBO employee
    await client.query(
      `UPDATE employees SET qbo_employee_id = $1 WHERE id = $2`,
      [qbo_employee_id, local_employee_id]
    );

    // Mark the candidate as confirmed in the candidates table
    await client.query(
      `UPDATE employee_match_candidates
         SET user_reviewed = TRUE,
             user_confirmed = TRUE,
             confirmed_by = $1,
             confirmed_at = NOW()
       WHERE local_employee_id = $2 AND qbo_employee_id = $3`,
      [req.user.id, local_employee_id, qbo_employee_id]
    );

    // Clean up any other unconfirmed candidates for this employee
    await client.query(
      `DELETE FROM employee_match_candidates
        WHERE local_employee_id = $1 AND qbo_employee_id <> $2`,
      [local_employee_id, qbo_employee_id]
    );

    await client.query('COMMIT');

    res.json({
      success: true,
      local_employee_id,
      qbo_employee_id,
      message: 'Match confirmed and employee linked.',
    });
  } catch (err) {
    try {
      await client.query('ROLLBACK');
    } catch {}
    console.error('POST /qbo-match/confirm-match failed:', err);
    res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }
});

module.exports = router;
