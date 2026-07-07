// One-off: seed staff phone numbers/extensions from Darren's 2026-07-07 list,
// and print the employees table columns. Run: railway run node scripts/set-staff-contacts.js
'use strict';
const { query } = require('../db/connection');

(async () => {
  try {
    const updates = [
      [1,  '519-889-1343', '104'], // Darren Holm
      [6,  '519-375-1919', '102'], // Corson Engel
      [8,  '519-540-8660', '101'], // Bryce Quanbury
      [12, '226-230-4567', '108'], // Brady Yzerman
      [15, '519-881-6531', '103'], // Travis Waugh
    ];
    for (const [id, phone, ext] of updates) {
      const r = await query(
        `UPDATE employees SET phone_number = $1, phone_extension = $2
          WHERE id = $3
         RETURNING id, first_name, last_name, phone_number, phone_extension`,
        [phone, ext, id]
      );
      console.log('updated:', JSON.stringify(r.rows || r));
    }
    const cols = await query(
      `SELECT column_name, data_type, is_nullable, column_default
         FROM information_schema.columns
        WHERE table_name = 'employees'
        ORDER BY ordinal_position`
    );
    console.log('columns:', (cols.rows || cols).map((c) => `${c.column_name}(${c.data_type}${c.is_nullable === 'NO' ? ' NOT NULL' : ''})`).join(', '));
  } catch (e) {
    console.error('ERROR:', e.message);
  }
  process.exit(0);
})();
