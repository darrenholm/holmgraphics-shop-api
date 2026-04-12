// db/discover-schema.js
// Run this ONCE with: node db/discover-schema.js
// It connects to Azure SQL and prints every table + column so you can
// verify the column names match what the API expects.

require('dotenv').config();
const { query } = require('./connection');

const TABLES_WE_USE = [
  'Projects', 'Clients', 'CAddress', 'ClPhone',
  'Employee', 'Status', 'StatusChange',
  'Notes', 'Items', 'Measurements',
  'ProjectType', 'PhoneType', 'AddressType'
];

async function discover() {
  console.log('\n=== HolmGraphicsMain Schema Discovery ===\n');

  for (const table of TABLES_WE_USE) {
    try {
      const rows = await query(`
        SELECT c.name AS column_name, ty.name AS data_type, c.is_nullable
        FROM sys.tables t
        JOIN sys.columns c ON t.object_id = c.object_id
        JOIN sys.types ty ON c.user_type_id = ty.user_type_id
        WHERE t.name = '${table}'
        ORDER BY c.column_id
      `);

      if (rows.length === 0) {
        console.log(`⚠️  ${table}: TABLE NOT FOUND\n`);
        continue;
      }

      console.log(`📋 ${table}`);
      rows.forEach(r => {
        const nullable = r.is_nullable ? '' : ' NOT NULL';
        console.log(`   ${r.column_name.padEnd(30)} ${r.data_type}${nullable}`);
      });

      // Also show first 2 rows as sample
      try {
        const sample = await query(`SELECT TOP 2 * FROM [${table}]`);
        if (sample.length > 0) {
          console.log(`   → Sample row keys: ${Object.keys(sample[0]).join(', ')}`);
        }
      } catch {}

      console.log('');
    } catch (e) {
      console.log(`❌ ${table}: ${e.message}\n`);
    }
  }

  console.log('\n=== Done ===');
  console.log('Compare these column names with the API routes in routes/');
  console.log('and update any mismatches in db/column-map.js\n');
  process.exit(0);
}

discover().catch(e => {
  console.error('Connection failed:', e.message);
  console.error('Check your .env file — DB_SERVER, DB_USER, DB_PASSWORD, DB_NAME');
  process.exit(1);
});
