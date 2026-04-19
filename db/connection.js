// db/connection.js
// Railway Postgres connection pool using node-postgres (`pg`).
//
// Parameterized queries use positional placeholders: $1, $2, $3 ...
// The `params` argument is an ordinary array, e.g.:
//    query('SELECT * FROM clients WHERE id = $1', [id])
require('dotenv').config();
const { Pool } = require('pg');

// DATABASE_URL is injected by Railway for services attached to a Postgres
// plugin. For local dev, set it in .env to the *public* proxy URL from
// Railway dashboard → Postgres → Connect ("DATABASE_PUBLIC_URL").
const connectionString = process.env.DATABASE_URL;
if (!connectionString) {
  console.error('FATAL: DATABASE_URL is not set. Add it to .env (local dev) '
    + 'or attach the Postgres service in Railway (production).');
  process.exit(1);
}

const pool = new Pool({
  connectionString,
  max: 10,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 10000,
});

pool.on('error', (err) => {
  console.error('Postgres pool error:', err);
});

// Run a parameterized query; returns an array of rows (possibly empty).
async function query(text, params = []) {
  const result = await pool.query(text, params);
  return result.rows;
}

// Run a query and return the first row, or null.
async function queryOne(text, params = []) {
  const rows = await query(text, params);
  return rows[0] || null;
}

module.exports = { pool, query, queryOne };
