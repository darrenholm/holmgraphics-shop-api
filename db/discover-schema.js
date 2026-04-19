// db/discover-schema.js
// Run this with: node db/discover-schema.js
// Connects to Railway Postgres and prints every table + column so you can
// verify the column names match what the API expects.

require('dotenv').config();
const { pool, query } = require('./connection');

const TABLES_WE_USE = [
  'projects', 'clients', 'client_addresses', 'client_phones',
  'employees', 'status', 'project_type',
  'notes', 'items', 'measurements', 'audit_log',
  'led_signs', 'led_service', 'project_files',
  'qb_items', 'modules', 'employee_tools',
  'client_preferences', 'client_wifi', 'alert_rules',
];

async function discover() {
  console.log('\n=== Railway Postgres Schema Discovery ===\n');

  for (const table of TABLES_WE_USE) {
    try {
      const rows = await query(
        `SELECT column_name, data_type, is_nullable
           FROM information_schema.columns
          WHERE table_schema = 'public' AND table_name = $1
          ORDER BY ordinal_position`,
        [table]
      );

      if (rows.length === 0) {
        console.log(`?? ${table}: TABLE NOT FOUND\n`);
        continue;
      }

      console.log(`[${table}]`);
      rows.forEach(r => {
        const nullable = r.is_nullable === 'NO' ? ' NOT NULL' : '';
        console.log(`   ${r.column_name.padEnd(30)} ${r.data_type}${nullable}`);
      });

      try {
        const sample = await query(`SELECT * FROM "${table}" LIMIT 2`);
        if (sample.length > 0) {
          console.log(`   -> Sample row keys: ${Object.keys(sample[0]).join(', ')}`);
        } else {
          console.log(`   -> (empty)`);
        }
      } catch {}

      console.log('');
    } catch (e) {
      console.log(`ERR ${table}: ${e.message}\n`);
    }
  }

  console.log('\n=== Done ===');
  await pool.end();
}

discover().catch(async (e) => {
  console.error('Connection failed:', e.message);
  console.error('Check your .env file - DATABASE_URL should be the Railway public proxy URL.');
  try { await pool.end(); } catch {}
  process.exit(1);
});
