// db/migrate.js
// Minimal migration runner. Applies every .sql file in db/migrations/
// that hasn't been applied yet (tracked in _migrations table).
//
// Called on server boot (from server.js) AND runnable as a CLI:
//   node db/migrate.js
//
// Safe to run repeatedly. Idempotent migrations (IF NOT EXISTS) are
// still a good idea since failures mid-run are possible.
require('dotenv').config();
const fs   = require('fs');
const path = require('path');
const { pool, query } = require('./connection');

const MIGRATIONS_DIR = path.join(__dirname, 'migrations');

async function ensureTrackingTable() {
  await query(`
    CREATE TABLE IF NOT EXISTS _migrations (
      filename    TEXT        PRIMARY KEY,
      applied_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);
}

async function appliedSet() {
  const rows = await query(`SELECT filename FROM _migrations`);
  return new Set(rows.map((r) => r.filename));
}

// Returns { ran, skipped }. Throws on failure.
async function runMigrations({ log = console.log } = {}) {
  if (!fs.existsSync(MIGRATIONS_DIR)) {
    log(`migrations: no dir at ${MIGRATIONS_DIR}`);
    return { ran: 0, skipped: 0 };
  }
  await ensureTrackingTable();
  const done = await appliedSet();

  const files = fs.readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith('.sql'))
    .sort();

  let ran = 0, skipped = 0;
  for (const file of files) {
    if (done.has(file)) { skipped++; continue; }
    const sql = fs.readFileSync(path.join(MIGRATIONS_DIR, file), 'utf8');
    log(`migrations: applying ${file}`);
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(sql);
      await client.query(
        `INSERT INTO _migrations (filename) VALUES ($1)`,
        [file]
      );
      await client.query('COMMIT');
      ran++;
    } catch (e) {
      await client.query('ROLLBACK');
      throw new Error(`migration ${file} failed: ${e.message}`);
    } finally {
      client.release();
    }
  }
  log(`migrations: applied ${ran}, skipped ${skipped}`);
  return { ran, skipped };
}

module.exports = { runMigrations };

// CLI entry point — only run when invoked directly.
if (require.main === module) {
  runMigrations()
    .then(() => pool.end())
    .catch((e) => { console.error(e.message); pool.end(); process.exit(1); });
}
