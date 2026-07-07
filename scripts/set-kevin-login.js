// One-off: give Kevin Barnard (employee 16) a login — email + temporary
// password, flagged must_change_password so the shop forces a reset on
// first login. Applies migration 055's column first so this can run ahead
// of the deploy. Run: railway run node scripts/set-kevin-login.js
'use strict';
const bcrypt = require('bcryptjs');
const { query } = require('../db/connection');

(async () => {
  try {
    await query(`ALTER TABLE employees ADD COLUMN IF NOT EXISTS must_change_password BOOLEAN NOT NULL DEFAULT FALSE`);
    const hash = await bcrypt.hash('password@1', 12);
    const r = await query(
      `UPDATE employees
          SET email = $1, password_hash = $2, must_change_password = TRUE
        WHERE id = 16
       RETURNING id, first_name, last_name, email, role, active, must_change_password`,
      ['kevin@holmgraphics.ca', hash]
    );
    console.log(JSON.stringify(r.rows || r));
  } catch (e) {
    console.error('ERROR:', e.message);
  }
  process.exit(0);
})();
