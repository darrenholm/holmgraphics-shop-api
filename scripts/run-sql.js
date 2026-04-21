// scripts/run-sql.js
//
// Minimal SQL-file runner for local psql-less environments.
// Usage: node scripts/run-sql.js db/migrations/003_add_category.sql
//
// Uses the same DATABASE_URL the app reads from (so you can point this at
// prod with the public proxy URL, or at local dev, without editing code).

const fs = require('fs');
const path = require('path');
const { Pool } = require('pg');

const filePath = process.argv[2];
if (!filePath) {
  console.error('Usage: node scripts/run-sql.js <path-to-sql-file>');
  process.exit(1);
}

const abs = path.resolve(filePath);
if (!fs.existsSync(abs)) {
  console.error(`File not found: ${abs}`);
  process.exit(1);
}

const sql = fs.readFileSync(abs, 'utf8');
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  // Railway's public proxy requires TLS; node-postgres needs this to negotiate.
  ssl: process.env.DATABASE_URL?.includes('proxy.rlwy.net')
    ? { rejectUnauthorized: false }
    : false,
});

(async () => {
  console.log(`Running ${path.basename(abs)}…`);
  try {
    const res = await pool.query(sql);
    console.log('OK.');
    if (Array.isArray(res)) {
      console.log(`${res.length} statements executed.`);
    }
  } catch (e) {
    console.error('FAILED:', e.message);
    process.exit(1);
  } finally {
    await pool.end();
  }
})();
