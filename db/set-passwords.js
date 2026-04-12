// db/set-passwords.js
// Run once to set initial passwords for your employees:
//   node db/set-passwords.js
//
// Edit the EMPLOYEES array below with real names and temporary passwords.
// Employees should change their password after first login.

require('dotenv').config();
const bcrypt = require('bcryptjs');
const { sql, query } = require('./connection');
const C = require('./column-map');
const E = C.Employee;

// ── EDIT THIS LIST ────────────────────────────────────────────────────────────
const EMPLOYEES = [
  { email: 'darren@holmgraphics.ca', password: 'admin2026', role: 'admin' },
  // Add more staff:
  // { email: 'staff@holmgraphics.ca', password: 'welcome123', role: 'staff' },
];
// ─────────────────────────────────────────────────────────────────────────────

async function run() {
  console.log('\n=== Setting Employee Passwords ===\n');

  for (const emp of EMPLOYEES) {
    try {
      const hash = await bcrypt.hash(emp.password, 12);
      const result = await query(
        `UPDATE Employee
         SET [${E.passwordHash}] = @hash, [${E.role}] = @role
         WHERE [${E.email}] = @email`,
        {
          hash:  { type: sql.VarChar(255), value: hash },
          role:  { type: sql.VarChar(50),  value: emp.role },
          email: { type: sql.VarChar(255), value: emp.email },
        }
      );
      console.log(`✅ ${emp.email} — password set, role: ${emp.role}`);
    } catch (e) {
      console.log(`❌ ${emp.email} — FAILED: ${e.message}`);
    }
  }

  console.log('\nDone. These are temporary passwords — change them after first login.\n');
  process.exit(0);
}

run().catch(e => {
  console.error('Failed:', e.message);
  process.exit(1);
});
