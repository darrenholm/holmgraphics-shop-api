#!/usr/bin/env node
/**
 * scripts/backfill-client-phones.js
 *
 * One-off populate of client_phone_index (migration 057) — the normalized
 * E.164 surface the inbound-call screen pop matches against.
 *
 * Reads every number from ALL THREE sources:
 *   client_phones.number    (staff-entered contact list)
 *   clients.phone           (DTF-store self-serve signup)
 *   projects.contact_phone  (the per-job contact)
 *
 * The third matters more than it sounds: plenty of clients have no
 * client_phones row at all and exist only as a number typed onto a job.
 *
 * Every number that fails to parse is written to a report file rather than
 * silently dropped. Expect junk in that column — "call the shop", "same",
 * "N/A", fax lines typed into the notes field, 7-digit local numbers from
 * before area codes were mandatory. The report is the worklist for cleaning
 * them up; nothing here edits the source rows.
 *
 * Usage:
 *   node scripts/backfill-client-phones.js              # write the index
 *   node scripts/backfill-client-phones.js --dry-run    # report only
 *   node scripts/backfill-client-phones.js --out foo.csv
 *
 * Safe to re-run: the index is rebuilt from scratch each time.
 */

'use strict';

require('dotenv').config();
const fs   = require('fs');
const path = require('path');
const { pool, query } = require('../db/connection');
const { toE164 } = require('../lib/phone');

const args   = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const outIdx = args.indexOf('--out');
const outPath = outIdx >= 0 && args[outIdx + 1]
  ? args[outIdx + 1]
  : path.join(__dirname, 'unparseable-phones.csv');

function csvCell(v) {
  const s = v === null || v === undefined ? '' : String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

async function main() {
  console.log(dryRun ? 'DRY RUN — no writes\n' : 'Backfilling client_phone_index\n');

  const [phoneRows, clientRows, jobRows] = await Promise.all([
    query(`SELECT p.id, p.client_id, p.number, p.phone_type,
                  COALESCE(c.company, CONCAT_WS(' ', c.fname, c.lname)) AS client_name
             FROM client_phones p
             JOIN clients c ON c.id = p.client_id
            ORDER BY p.client_id, p.id`),
    query(`SELECT id, phone,
                  COALESCE(company, CONCAT_WS(' ', fname, lname)) AS client_name
             FROM clients
            WHERE phone IS NOT NULL AND phone <> ''
            ORDER BY id`),
    query(`SELECT p.id, p.client_id, p.contact_phone,
                  COALESCE(c.company, CONCAT_WS(' ', c.fname, c.lname)) AS client_name
             FROM projects p
             JOIN clients c ON c.id = p.client_id
            WHERE p.contact_phone IS NOT NULL AND p.contact_phone <> ''
            ORDER BY p.client_id, p.created_date DESC NULLS LAST, p.id DESC`),
  ]);

  console.log(`  client_phones rows    : ${phoneRows.length}`);
  console.log(`  clients.phone rows    : ${clientRows.length}`);
  console.log(`  job contact_phone rows: ${jobRows.length}\n`);

  // clientId → Map(e164 → { label, source_field }). The Map de-dupes the
  // common case where the same number sits in both sources.
  const index = new Map();
  const bad = [];

  const add = (clientId, e164, label, sourceField) => {
    if (!index.has(clientId)) index.set(clientId, new Map());
    const m = index.get(clientId);
    if (!m.has(e164)) m.set(e164, { label, sourceField });
  };

  for (const r of phoneRows) {
    const e164 = toE164(r.number);
    if (e164) add(r.client_id, e164, r.phone_type || null, `client_phones.number#${r.id}`);
    else bad.push({
      source: 'client_phones.number',
      source_id: r.id,
      client_id: r.client_id,
      client_name: r.client_name,
      label: r.phone_type,
      raw: r.number,
    });
  }

  for (const r of clientRows) {
    const e164 = toE164(r.phone);
    if (e164) add(r.id, e164, 'main', 'clients.phone');
    else bad.push({
      source: 'clients.phone',
      source_id: r.id,
      client_id: r.id,
      client_name: r.client_name,
      label: 'main',
      raw: r.phone,
    });
  }

  // Read last, so a number already on the curated contact list keeps that
  // list's label rather than being relabelled "Job contact".
  for (const r of jobRows) {
    const e164 = toE164(r.contact_phone);
    if (e164) add(r.client_id, e164, 'Job contact', `projects.contact_phone#${r.id}`);
    else bad.push({
      source: 'projects.contact_phone',
      source_id: r.id,
      client_id: r.client_id,
      client_name: r.client_name,
      label: 'Job contact',
      raw: r.contact_phone,
    });
  }

  const totalNumbers = [...index.values()].reduce((n, m) => n + m.size, 0);
  console.log(`  parsed             : ${totalNumbers} numbers across ${index.size} clients`);
  console.log(`  unparseable        : ${bad.length}\n`);

  // ─── Report ────────────────────────────────────────────────────────────────
  const header = 'source,source_id,client_id,client_name,label,raw_value\n';
  const body = bad.map((b) => [
    b.source, b.source_id, b.client_id, b.client_name, b.label, b.raw,
  ].map(csvCell).join(',')).join('\n');
  fs.writeFileSync(outPath, header + body + (body ? '\n' : ''), 'utf8');
  console.log(`  report → ${outPath}`);

  if (bad.length) {
    console.log('\n  First 15 unparseable values:');
    for (const b of bad.slice(0, 15)) {
      console.log(`    ${String(b.client_id).padStart(6)}  ${String(b.client_name || '').slice(0, 28).padEnd(28)}  ${JSON.stringify(b.raw)}`);
    }
    if (bad.length > 15) console.log(`    … and ${bad.length - 15} more (see the CSV)`);
  }

  // ─── Collisions ────────────────────────────────────────────────────────────
  // One number owned by several clients is legitimate (a shop line shared by
  // two contacts, a spouse's mobile on both accounts) but it means those calls
  // pop a "which of these?" card instead of a name. Worth eyeballing once.
  const byNumber = new Map();
  for (const [clientId, m] of index) {
    for (const e164 of m.keys()) {
      if (!byNumber.has(e164)) byNumber.set(e164, []);
      byNumber.get(e164).push(clientId);
    }
  }
  const shared = [...byNumber.entries()].filter(([, ids]) => ids.length > 1);
  console.log(`\n  numbers shared by >1 client: ${shared.length}`);
  for (const [e164, ids] of shared.slice(0, 10)) {
    console.log(`    ${e164} → clients ${ids.join(', ')}`);
  }
  if (shared.length > 10) console.log(`    … and ${shared.length - 10} more`);

  if (dryRun) {
    console.log('\nDry run — index not written.');
    return;
  }

  // ─── Write ─────────────────────────────────────────────────────────────────
  // Full rebuild in one transaction: either the index matches the source data
  // or it's untouched. A half-written index would pop wrong names.
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('TRUNCATE client_phone_index');
    let written = 0;
    for (const [clientId, m] of index) {
      for (const [e164, meta] of m) {
        await client.query(
          `INSERT INTO client_phone_index (client_id, e164, label, source_field)
           VALUES ($1, $2, $3, $4)
           ON CONFLICT (client_id, e164) DO NOTHING`,
          [clientId, e164, meta.label, meta.sourceField]
        );
        written++;
      }
    }
    await client.query('COMMIT');
    console.log(`\n  wrote ${written} index rows.`);
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}

main()
  .then(() => pool.end())
  .catch((e) => {
    console.error('\nFAILED:', e.message);
    pool.end();
    process.exit(1);
  });
