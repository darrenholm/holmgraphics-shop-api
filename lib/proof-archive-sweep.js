// lib/proof-archive-sweep.js
//
// Daily background sweep that deletes the WHC file for any project_proof
// row that has been status='superseded' for more than 90 days. The DB
// row stays — it's part of the audit trail and the project_messages
// thread references the version — but the public image URL becomes a
// 404. This keeps the public proofs folder from accumulating thousands
// of stale artwork files over time.
//
// Scheduled from server.js: one timer per process, fires immediately
// on boot and then every 24 hours.

'use strict';

const ftp = require('basic-ftp');
const { query } = require('../db/connection');

const ARCHIVE_AFTER_DAYS = parseInt(process.env.PROOF_ARCHIVE_DAYS || '90', 10);

// Same env names as routes/project-proofs.js — they share the WHC config.
const WHC_HOST        = process.env.WHC_FTP_HOST;
const WHC_PORT        = parseInt(process.env.WHC_FTP_PORT || '21', 10);
const WHC_USER        = process.env.WHC_FTP_USER;
const WHC_PASS        = process.env.WHC_FTP_PASSWORD;
const WHC_SECURE      = process.env.WHC_FTP_SECURE !== 'false';
const WHC_REMOTE_BASE = (process.env.WHC_REMOTE_BASE || 'public_html/shop-uploads/jobs').replace(/\/$/, '');

function whcConfigured() {
  return Boolean(WHC_HOST && WHC_USER && WHC_PASS);
}

async function connectFtp(timeoutMs = 30000) {
  const client = new ftp.Client(timeoutMs);
  client.ftp.verbose = false;
  await client.access({
    host: WHC_HOST, port: WHC_PORT, user: WHC_USER, password: WHC_PASS,
    secure: WHC_SECURE,
    secureOptions: WHC_SECURE ? { checkServerIdentity: () => undefined } : undefined,
  });
  return client;
}

// Runs one sweep. Idempotent — safe to call on boot AND nightly. Returns
// { scanned, archived, errors } so the caller can log a summary.
async function runProofArchiveSweep({ log = console.log } = {}) {
  if (!whcConfigured()) {
    log('[proof-archive] WHC not configured — skipping sweep');
    return { scanned: 0, archived: 0, errors: 0 };
  }

  const candidates = await query(
    `SELECT id, project_id, file_path
       FROM project_proofs
      WHERE status = 'superseded'
        AND archived_at IS NULL
        AND uploaded_at < NOW() - ($1 || ' days')::interval
      ORDER BY uploaded_at
      LIMIT 500`,
    [String(ARCHIVE_AFTER_DAYS)]
  );

  if (candidates.length === 0) {
    log(`[proof-archive] no proofs older than ${ARCHIVE_AFTER_DAYS} days to archive`);
    return { scanned: 0, archived: 0, errors: 0 };
  }

  log(`[proof-archive] archiving ${candidates.length} proof(s) older than ${ARCHIVE_AFTER_DAYS} days`);

  // One FTP connection per sweep — WHC throttles concurrent connections,
  // and the candidate count is bounded by the LIMIT above.
  let client;
  let archived = 0;
  let errors = 0;
  try {
    client = await connectFtp();
    for (const row of candidates) {
      const remotePath = `${WHC_REMOTE_BASE}/${row.project_id}/proofs/${row.file_path}`;
      try {
        // remove() returns success even if the file is already gone, which
        // matches the semantics we want — if WHC dropped the file outside
        // our knowledge, we still want to mark it archived locally.
        await client.remove(remotePath).catch((e) => {
          // 550 = file not found. Anything else is a real error.
          if (!/550/.test(String(e && e.message))) throw e;
        });
        await query(
          `UPDATE project_proofs SET archived_at = NOW() WHERE id = $1`,
          [row.id]
        );
        archived++;
      } catch (e) {
        errors++;
        log(`[proof-archive] failed to archive proof ${row.id}: ${e.message || e}`);
      }
    }
  } catch (e) {
    log(`[proof-archive] FTP connect failed: ${e.message || e}`);
    errors++;
  } finally {
    if (client) try { client.close(); } catch {}
  }

  log(`[proof-archive] done — archived ${archived}/${candidates.length}, errors ${errors}`);
  return { scanned: candidates.length, archived, errors };
}

// Schedule once-per-process. Fires shortly after boot (5 min delay so we
// don't slow down container startup), then every 24 hours.
function scheduleProofArchiveSweep() {
  const BOOT_DELAY_MS = 5 * 60 * 1000;
  const PERIOD_MS     = 24 * 60 * 60 * 1000;
  setTimeout(() => {
    runProofArchiveSweep().catch((e) => console.warn('[proof-archive] sweep threw:', e.message || e));
    setInterval(() => {
      runProofArchiveSweep().catch((e) => console.warn('[proof-archive] sweep threw:', e.message || e));
    }, PERIOD_MS);
  }, BOOT_DELAY_MS);
}

module.exports = { runProofArchiveSweep, scheduleProofArchiveSweep };
