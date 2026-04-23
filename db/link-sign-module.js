// db/link-sign-module.js
// Throwaway helper to sanity-check the new Modules tab end-to-end.
//
// Usage:
//   node db/link-sign-module.js              -> list signs + modules so you can pick
//   node db/link-sign-module.js <signId> <moduleId>
//                                            -> set led_signs.module_id = <moduleId>
//                                               for the given sign
//   node db/link-sign-module.js <signId> null
//                                            -> clear the link
//
// Safe to run against prod; it only touches the one row you point at.
// Delete this file once the admin Modules page lands.

require('dotenv').config();
const { pool, query } = require('./connection');

async function main() {
  const [, , signArg, moduleArg] = process.argv;

  if (!signArg) {
    const signs = await query(
      `SELECT s.id, s.sign_name, s.location, s.module_id,
              COALESCE(c.company, CONCAT_WS(' ', c.fname, c.lname)) AS client_name
         FROM led_signs s
         LEFT JOIN clients c ON c.id = s.client_id
        ORDER BY client_name NULLS LAST, s.sign_name NULLS LAST, s.id`
    );
    const modules = await query(
      `SELECT id, module_id_no, starting_inventory, on_hand
         FROM modules
        ORDER BY module_id_no NULLS LAST, id`
    );

    console.log('\n=== LED SIGNS ===');
    signs.forEach((s) =>
      console.log(
        `  [${String(s.id).padStart(4)}] ${String(s.client_name || '—').padEnd(28)} ` +
        `${String(s.sign_name || '—').padEnd(24)} ${s.location || ''}` +
        (s.module_id ? `  (linked → module #${s.module_id})` : '')
      )
    );

    console.log('\n=== MODULES ===');
    modules.forEach((m) =>
      console.log(
        `  [${String(m.id).padStart(4)}] ${String(m.module_id_no || '—').padEnd(20)} ` +
        `start=${m.starting_inventory ?? '—'}  on_hand=${m.on_hand ?? '—'}`
      )
    );

    console.log('\nLink a sign to a module:');
    console.log('  node db/link-sign-module.js <signId> <moduleId>');
    console.log('Unlink a sign:');
    console.log('  node db/link-sign-module.js <signId> null\n');
    await pool.end();
    return;
  }

  const signId = parseInt(signArg, 10);
  if (!Number.isInteger(signId)) throw new Error(`Invalid signId: ${signArg}`);

  let moduleId = null;
  if (moduleArg && moduleArg.toLowerCase() !== 'null') {
    moduleId = parseInt(moduleArg, 10);
    if (!Number.isInteger(moduleId)) throw new Error(`Invalid moduleId: ${moduleArg}`);
  }

  const rows = await query(
    `UPDATE led_signs
        SET module_id = $1
      WHERE id = $2
      RETURNING id, sign_name, client_id, module_id`,
    [moduleId, signId]
  );
  if (rows.length === 0) {
    console.log(`No sign with id=${signId}`);
  } else {
    console.log('Updated:', rows[0]);
  }
  await pool.end();
}

main().catch(async (e) => {
  console.error(e.message);
  try { await pool.end(); } catch {}
  process.exit(1);
});
