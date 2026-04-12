// db/connection.js
// Azure SQL connection pool using mssql (tedious driver)
require('dotenv').config();
const sql = require('mssql');

const config = {
  server: process.env.DB_SERVER,
  database: process.env.DB_NAME,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  port: parseInt(process.env.DB_PORT) || 1433,
  options: {
    encrypt: true,           // Required for Azure SQL
    trustServerCertificate: false,
    enableArithAbort: true,
    connectTimeout: 30000,
    requestTimeout: 30000,
  },
  pool: {
    max: 10,
    min: 0,
    idleTimeoutMillis: 30000
  }
};

let pool = null;

async function getPool() {
  if (pool) return pool;
  pool = await sql.connect(config);
  console.log('✅ Connected to Azure SQL:', process.env.DB_SERVER);
  return pool;
}

// Helper: run a parameterized query and return rows
async function query(text, params = {}) {
  const p = await getPool();
  const request = p.request();
  // Bind named parameters: { name: { type: sql.VarChar, value: 'x' } }
  for (const [key, { type, value }] of Object.entries(params)) {
    request.input(key, type, value);
  }
  const result = await request.query(text);
  return result.recordset;
}

// Helper: run query, return first row or null
async function queryOne(text, params = {}) {
  const rows = await query(text, params);
  return rows[0] || null;
}

module.exports = { sql, getPool, query, queryOne };
