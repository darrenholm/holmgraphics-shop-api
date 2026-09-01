// db/migrations.test.js
//
// Runs the daily-inspection migrations (060–062) against a real PostgreSQL
// and asserts the invariants they exist to enforce.
//
//   npm i -D @electric-sql/pglite      # ~25 MB, one time
//   npm run test:schema
//
// PGlite is deliberately NOT in package.json. It is a 25 MB WASM bundle and
// Railway would carry it on every build for a test that only needs to run
// when this schema changes. Without it installed, this file skips.
//
// Why this exists at all: a completed `inspections` row is a legal record
// under O. Reg. 199/07, and almost everything protecting it lives in
// plpgsql triggers rather than application code. Those triggers cannot be
// exercised by `node --test` against the app, they are invisible to code
// review once they are more than a few lines, and the failure mode is
// silent — a report that quietly accepts an edit still looks like a report.
// Reading the SQL is not evidence that it locks anything.
//
// The migrations reference tables created much earlier, so those are stubbed
// below with the shapes migrations 016 and 023 give them. If either of those
// changes shape, this file needs the same change.

'use strict';

const test   = require('node:test');
const assert = require('node:assert/strict');
const fs     = require('node:fs');
const path   = require('node:path');

let PGlite;
try {
  ({ PGlite } = require('@electric-sql/pglite'));
} catch {
  test('schema tests (skipped — run `npm i -D @electric-sql/pglite` to enable)',
    { skip: true }, () => {});
  return;
}

const MIGRATIONS = path.join(__dirname, 'migrations');
const FILES = [
  '060_daily_inspections.sql',
  '061_inspection_jobs.sql',
  '062_inspection_offline.sql',
  '063_schedule_1_official.sql',
];
const sqlFor = (f) => fs.readFileSync(path.join(MIGRATIONS, f), 'utf8');

// Tables the migrations build on, as they exist by migration 023.
const STUBS = `
CREATE TABLE employees (
  id SERIAL PRIMARY KEY, first_name TEXT, last_name TEXT,
  email TEXT, role TEXT DEFAULT 'staff', active BOOLEAN DEFAULT TRUE
);
CREATE TABLE vehicles (
  id SERIAL PRIMARY KEY,
  unit_number TEXT NOT NULL UNIQUE,
  type TEXT NOT NULL CHECK (type IN ('truck','trailer')),
  make TEXT, model TEXT, year INT, license_plate TEXT, vin TEXT, notes TEXT,
  active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
INSERT INTO employees (first_name,last_name,email,role) VALUES
  ('Darren','Holm','darren@holmgraphics.ca','admin'),
  ('Test','Driver','driver@holmgraphics.ca','staff');
-- The real fleet, as read off the permits in the build spec.
INSERT INTO vehicles (unit_number,type,make,model,year,license_plate) VALUES
  ('T-01','truck','Ford','F-150',2023,'BY24956'),
  ('T-02','truck','Ford','F-150',2024,'CB91031'),
  ('T-03','truck','RAM','ProMaster',2021,'BW28769'),
  ('T-04','truck','Ford','Ranger',2022,'CH38045'),
  ('Tr-02','trailer',NULL,'14ft Dump',NULL,'Y6359Z'),
  ('Tr-03','trailer',NULL,'22ft Flatbed (Skyjack)',NULL,'AH681F');
`;

// A fresh database per test: these assertions mutate rows, and a shared
// instance would make failures depend on execution order.
async function freshDb({ migrate = true, rerun = false } = {}) {
  const db = await PGlite.create();
  await db.exec(STUBS);
  if (migrate) {
    for (const f of FILES) await db.exec(sqlFor(f));
    if (rerun) for (const f of FILES) await db.exec(sqlFor(f));
  }
  return db;
}

const one = async (db, sql) => (await db.query(sql)).rows[0];

// Asserts a statement is rejected, and rejected for the stated reason —
// "it threw" is not enough when the point is WHICH guard caught it.
async function refuses(db, sql, because) {
  let raised = null;
  try { await db.exec(sql); } catch (e) { raised = e; }
  assert.ok(raised, `expected this to be refused, but it succeeded:\n${sql.trim()}`);
  if (because) {
    assert.ok(raised.message.includes(because),
      `refused, but not because of "${because}":\n  ${raised.message.split('\n')[0]}`);
  }
}

// Drives one unit through draft → defect → signed, and hands back the ids.
async function signedInspection(db, { severity = 'major' } = {}) {
  const V = (await one(db, `SELECT id FROM vehicles WHERE unit_number='T-02'`)).id;
  const S = (await one(db, `SELECT id FROM inspection_schedules WHERE active AND version=2`)).id;
  const E = (await one(db, `SELECT id FROM employees WHERE role='staff'`)).id;
  const A = (await one(db, `SELECT id FROM employees WHERE role='admin'`)).id;
  const item = (await one(db, `SELECT id FROM inspection_schedule_items
                                WHERE schedule_id=${S} AND severity='${severity}'
                                ORDER BY sort_order LIMIT 1`)).id;
  const spare = (await one(db, `SELECT id FROM inspection_schedule_items
                                 WHERE schedule_id=${S} AND severity='${severity}'
                                 ORDER BY sort_order DESC LIMIT 1`)).id;

  const { id } = await one(db, `
    INSERT INTO inspections (vehicle_id,schedule_id,carrier_name,plate,plate_jurisdiction,
                             inspector_employee_id,inspector_name)
    VALUES (${V},${S},'HOLM GRAPHICS INC.','CB91031','ON',${E},'Test Driver') RETURNING id`);
  await db.exec(`INSERT INTO inspection_defects (inspection_id,schedule_item_id,severity,note)
                 VALUES (${id},${item},'${severity}','brake out of adjustment')`);
  await db.exec(`UPDATE inspections SET completed_at=NOW(),
      status='${severity === 'major' ? 'out_of_service' : 'complete'}',
      odometer_km=52000, odometer_source='manual', location_text='Shop yard',
      location_source='manual', declaration_text='[PLACEHOLDER] I certify…',
      declaration_accepted_at=NOW(), submitted_at=NOW() WHERE id=${id}`);
  return { id, V, S, E, A, item, spare };
}

// ─── Applying ───────────────────────────────────────────────────────────────

test('all three migrations apply to a clean database', async () => {
  const db = await freshDb();
  const t = await one(db, `SELECT COUNT(*)::int n FROM information_schema.tables
                            WHERE table_name IN ('inspections','inspection_defects',
                              'inspection_schedules','inspection_schedule_items','scheduled_job_runs')`);
  assert.equal(t.n, 5);
});

test('a retried deploy can re-apply them without duplicating the seed', async () => {
  // db/migrate.js records applied files, but a deploy that dies mid-run can
  // leave a file half-applied and retry it. Seeding twice would give the
  // fleet two Schedule 1s and 68 items.
  const db = await freshDb({ rerun: true });
  const s = await one(db, `SELECT COUNT(*)::int n FROM inspection_schedules`);
  const i = await one(db, `SELECT COUNT(*)::int n FROM inspection_schedule_items`);
  const n = await one(db, `SELECT COUNT(*)::int n FROM inspection_schedule_notes`);
  assert.equal(s.n, 2, 'schedule seeded twice (expect v1 + v2 only)');
  assert.equal(i.n, 34 + 76, 'items seeded twice');
  assert.equal(n.n, 11, 'notes seeded twice');
});

test('Schedule 1 v2 matches the regulation part by part', async () => {
  // Counted off O. Reg. 199/07, Sched. 1 as published: [part, minor, major].
  // A carrier may ADD items to Schedule 1 but may not drop any, so a seed
  // that quietly loses a defect is the failure this is here to catch.
  const EXPECTED = [
    [1,2,5],  [2,1,1],  [3,1,2],  [4,1,3],  [5,0,1],  [6,1,0],
    [7,1,1],  [8,1,2],  [9,1,0],  [10,1,1], [11,1,1], [12,1,2],
    [13,0,1], [14,2,0], [15,1,1], [16,1,0], [17,1,6], [18,2,4],
    [19,1,2], [20,3,4], [21,2,6], [22,2,3], [23,2,1],
  ];
  const db = await freshDb();
  const v2 = (await one(db, `SELECT id FROM inspection_schedules WHERE version=2`)).id;
  const rows = (await db.query(
    `SELECT part_number,
            COUNT(*) FILTER (WHERE severity='minor')::int minor,
            COUNT(*) FILTER (WHERE severity='major')::int major
       FROM inspection_schedule_items WHERE schedule_id=${v2}
      GROUP BY part_number ORDER BY part_number`)).rows;

  assert.equal(rows.length, 23, 'Schedule 1 has 23 Parts');
  for (const [part, minor, major] of EXPECTED) {
    const got = rows.find((r) => r.part_number === part);
    assert.ok(got, `Part ${part} missing`);
    assert.equal(got.minor, minor, `Part ${part} minor defect count`);
    assert.equal(got.major, major, `Part ${part} major defect count`);
  }
  const total = await one(db, `SELECT COUNT(*)::int n FROM inspection_schedule_items WHERE schedule_id=${v2}`);
  assert.equal(total.n, 76);
});

test('every v2 defect carries a severity, and none say PLACEHOLDER', async () => {
  // Severity now comes off the row rather than being chosen by the driver,
  // so a row without one would be unusable — the API refuses to flag it.
  const db = await freshDb();
  const v2 = (await one(db, `SELECT id FROM inspection_schedules WHERE version=2`)).id;
  const r = await one(db, `SELECT
      COUNT(*) FILTER (WHERE severity IS NULL)::int no_sev,
      COUNT(*) FILTER (WHERE item_label LIKE '%PLACEHOLDER%')::int placeholder,
      COUNT(*) FILTER (WHERE item_label IS NULL OR item_label='')::int empty
      FROM inspection_schedule_items WHERE schedule_id=${v2}`);
  assert.equal(r.no_sev, 0);
  assert.equal(r.placeholder, 0, 'v2 is the official text; nothing should be marked placeholder');
  assert.equal(r.empty, 0);
});

test('the conditional major defects in Parts 18 and 23 keep their qualifier', async () => {
  // "When use of lamps is required" and "At all times" change what the
  // defect means. Dropping them would change what the regulation says.
  const db = await freshDb();
  const v2 = (await one(db, `SELECT id FROM inspection_schedules WHERE version=2`)).id;
  const rows = (await db.query(
    `SELECT DISTINCT condition_note FROM inspection_schedule_items
      WHERE schedule_id=${v2} AND condition_note IS NOT NULL ORDER BY 1`)).rows
    .map((r) => r.condition_note);
  assert.deepEqual(rows, [
    'At all times',
    'When use of lamps is required',
    'When use of wipers or washer is required',
  ]);
});

test('footnote references survive into the seed', async () => {
  const db = await freshDb();
  const v2 = (await one(db, `SELECT id FROM inspection_schedules WHERE version=2`)).id;
  const r = await one(db, `SELECT COUNT(*)::int n FROM inspection_schedule_items
                            WHERE schedule_id=${v2} AND footnote_refs IS NOT NULL`);
  assert.equal(r.n, 11, 'eleven Schedule 1 entries carry a superscript note reference');
  const notes = await one(db, `SELECT COUNT(*)::int n FROM inspection_schedule_notes WHERE schedule_id=${v2}`);
  assert.equal(notes.n, 11);
});

test('v1 is retired but not deleted', async () => {
  // Reports signed against the placeholder schedule still point at it and
  // must keep rendering the text they were signed against.
  const db = await freshDb();
  const r = await one(db, `SELECT active FROM inspection_schedules WHERE version=1`);
  assert.equal(r.active, false, 'v1 should no longer be offered for new checks');
  const items = await one(db, `SELECT COUNT(*)::int n FROM inspection_schedule_items i
                                 JOIN inspection_schedules s ON s.id=i.schedule_id WHERE s.version=1`);
  assert.equal(items.n, 34, 'v1 items must survive for already-signed reports');
});

// ─── On-demand policy (063) ─────────────────────────────────────────────────

test('the fleet defaults to on-demand checks, not daily', async () => {
  const db = await freshDb();
  const r = await one(db, `SELECT COUNT(*) FILTER (WHERE inspection_policy='on_demand')::int od,
                                  COUNT(*)::int total FROM vehicles`);
  assert.equal(r.od, r.total);
});

test('policy is independent of whether the regulation applies', async () => {
  // The two must not collapse into one flag: inspection_required is a fact
  // about O. Reg. 199/07, inspection_policy is an operating decision. T-02
  // is in scope AND on-demand at the same time, and the board says so.
  const db = await freshDb();
  const r = await one(db, `SELECT inspection_required ir, inspection_policy p
                             FROM vehicles WHERE unit_number='T-02'`);
  assert.equal(r.ir, true,  'T-02 is still covered by the regulation');
  assert.equal(r.p, 'on_demand', 'and is still only checked on demand');

  await db.exec(`UPDATE vehicles SET inspection_policy='daily' WHERE unit_number='T-02'`);
  const after = await one(db, `SELECT inspection_required ir, inspection_policy p
                                 FROM vehicles WHERE unit_number='T-02'`);
  assert.equal(after.p, 'daily');
  assert.equal(after.ir, true, 'changing policy must not touch the regulatory fact');
});

test('a check records the trailer that was attached', async () => {
  const db = await freshDb();
  const { id } = await signedInspection(db);
  const tr = (await one(db, `SELECT id FROM vehicles WHERE unit_number='Tr-03'`)).id;
  // Set before signing in real use; here the row is already frozen, so this
  // doubles as a check that towing_vehicle_id is part of the frozen record.
  await refuses(db, `UPDATE inspections SET towing_vehicle_id=${tr} WHERE id=${id}`, 'is immutable');
});

// ─── The seed ───────────────────────────────────────────────────────────────

test('the seeded schedule is marked unverified', async () => {
  const db = await freshDb();
  const r = await one(db, `SELECT source_verified FROM inspection_schedules WHERE active AND version=2`);
  assert.equal(r.source_verified, false,
    'placeholder wording must never ship as verified — the banner and the per-report warning key off this');
});

test('the retired v1 seed is still entirely marked PLACEHOLDER', async () => {
  const db = await freshDb();
  const r = await one(db, `SELECT COUNT(*)::int n FROM inspection_schedule_items i
                             JOIN inspection_schedules s ON s.id=i.schedule_id
                            WHERE s.version=1
                              AND COALESCE(i.minor_defect_text,'') NOT LIKE '%PLACEHOLDER%'
                              AND COALESCE(i.major_defect_text,'') NOT LIKE '%PLACEHOLDER%'`);
  assert.equal(r.n, 0, 'unmarked text could be mistaken for regulation wording on a signed report');
});

// ─── Scope, derived from RGW ────────────────────────────────────────────────

test('scope comes out of the permits: T-02 in, everything else out', async () => {
  const db = await freshDb();
  const rows = (await db.query(
    `SELECT unit_number, registered_gross_weight_kg w, inspection_required ir
       FROM vehicles ORDER BY unit_number`)).rows;
  const by = Object.fromEntries(rows.map((r) => [r.unit_number, r]));
  assert.equal(by['T-02'].ir, true,  'T-02 is plated at 6000 kg');
  assert.equal(by['T-03'].ir, false);
  assert.equal(by['T-04'].ir, false);
});

test('a unit at exactly 4,500 kg is OUT of scope', async () => {
  // The regulation excludes "not more than 4,500 kilograms", so the test is
  // strictly greater. T-01 sits exactly on the line and getting this
  // backwards would put a truck in scope that does not belong there.
  const db = await freshDb();
  const r = await one(db, `SELECT registered_gross_weight_kg w, inspection_required ir
                             FROM vehicles WHERE unit_number='T-01'`);
  assert.equal(r.w, 4500);
  assert.equal(r.ir, false);
});

test('unknown RGW is not asserted as out of scope — it stays a visible gap', async () => {
  const db = await freshDb();
  const r = await one(db, `SELECT registered_gross_weight_kg w, inspection_required ir
                             FROM vehicles WHERE unit_number='Tr-03'`);
  assert.equal(r.w, null, 'Tr-03 (the Skyjack trailer) has no RGW on the permit list');
  assert.equal(r.ir, false, 'unknown must not silently become "in scope"');
});

test('re-plating a unit re-derives its scope automatically', async () => {
  // RGW changes at the plate counter, not in the shop. If this needed a
  // developer, scope would drift out of date and nobody would notice.
  const db = await freshDb();
  await db.exec(`UPDATE vehicles SET registered_gross_weight_kg=7000 WHERE unit_number='Tr-03'`);
  assert.equal((await one(db, `SELECT inspection_required ir FROM vehicles WHERE unit_number='Tr-03'`)).ir, true);
  await db.exec(`UPDATE vehicles SET registered_gross_weight_kg=3000 WHERE unit_number='Tr-03'`);
  assert.equal((await one(db, `SELECT inspection_required ir FROM vehicles WHERE unit_number='Tr-03'`)).ir, false);
});

test('every active unit, trailers included, is on Schedule 1 v2', async () => {
  // Schedule 1 is titled "DAILY INSPECTION OF TRUCKS, TRACTORS AND
  // TRAILERS". Migration 060 assumed trailers needed a separate schedule
  // and left them unassigned; 063 corrects that.
  const db = await freshDb();
  const v2 = (await one(db, `SELECT id FROM inspection_schedules WHERE version=2`)).id;
  const r = await one(db, `SELECT COUNT(*)::int n FROM vehicles
                            WHERE active AND inspection_schedule_id IS DISTINCT FROM ${v2}`);
  assert.equal(r.n, 0, 'some active unit is not pointed at Schedule 1 v2');
});

// ─── Draft lifecycle ────────────────────────────────────────────────────────

test('a draft carries no validity until it is signed', async () => {
  const db = await freshDb();
  const V = (await one(db, `SELECT id FROM vehicles WHERE unit_number='T-02'`)).id;
  const S = (await one(db, `SELECT id FROM inspection_schedules WHERE version=1`)).id;
  const E = (await one(db, `SELECT id FROM employees WHERE role='staff'`)).id;
  const { id } = await one(db, `
    INSERT INTO inspections (vehicle_id,schedule_id,carrier_name,plate,plate_jurisdiction,
      inspector_employee_id,inspector_name)
    VALUES (${V},${S},'HG','CB91031','ON',${E},'D') RETURNING id`);
  const r = await one(db, `SELECT valid_until, status FROM inspections WHERE id=${id}`);
  assert.equal(r.valid_until, null);
  assert.equal(r.status, 'in_progress');
});

test('one driver cannot have two open checks on the same unit', async () => {
  const db = await freshDb();
  const V = (await one(db, `SELECT id FROM vehicles WHERE unit_number='T-02'`)).id;
  const S = (await one(db, `SELECT id FROM inspection_schedules WHERE version=1`)).id;
  const E = (await one(db, `SELECT id FROM employees WHERE role='staff'`)).id;
  const insert = `INSERT INTO inspections (vehicle_id,schedule_id,carrier_name,plate,
    plate_jurisdiction,inspector_employee_id,inspector_name)
    VALUES (${V},${S},'HG','CB91031','ON',${E},'D')`;
  await db.exec(insert);
  await refuses(db, insert, 'uniq_inspection_in_progress');
});

test('an incomplete report cannot be signed', async () => {
  const db = await freshDb();
  const V = (await one(db, `SELECT id FROM vehicles WHERE unit_number='T-02'`)).id;
  const S = (await one(db, `SELECT id FROM inspection_schedules WHERE version=1`)).id;
  const E = (await one(db, `SELECT id FROM employees WHERE role='staff'`)).id;
  const { id } = await one(db, `
    INSERT INTO inspections (vehicle_id,schedule_id,carrier_name,plate,plate_jurisdiction,
      inspector_employee_id,inspector_name)
    VALUES (${V},${S},'HG','CB91031','ON',${E},'D') RETURNING id`);
  await refuses(db,
    `UPDATE inspections SET completed_at=NOW(), status='complete',
       odometer_km=1000, odometer_source='manual' WHERE id=${id}`,
    'inspections_complete_has_required_fields');
});

test('validity runs 24 hours from completion', async () => {
  const db = await freshDb();
  const { id } = await signedInspection(db);
  const r = await one(db, `SELECT EXTRACT(EPOCH FROM (valid_until - completed_at))::int s
                             FROM inspections WHERE id=${id}`);
  assert.equal(r.s, 86400);
});

// ─── Immutability: the whole point ──────────────────────────────────────────

test('a signed report refuses every edit to its content', async () => {
  const db = await freshDb();
  const { id } = await signedInspection(db);
  for (const [what, sql] of [
    ['odometer',    `UPDATE inspections SET odometer_km=99999 WHERE id=${id}`],
    ['declaration', `UPDATE inspections SET declaration_text='something else' WHERE id=${id}`],
    ['inspector',   `UPDATE inspections SET inspector_name='Someone Else' WHERE id=${id}`],
    ['plate',       `UPDATE inspections SET plate='XXXXXXX' WHERE id=${id}`],
    ['location',    `UPDATE inspections SET location_text='Somewhere else' WHERE id=${id}`],
    ['carrier',     `UPDATE inspections SET carrier_name='Someone Ltd' WHERE id=${id}`],
    ['completed_at',`UPDATE inspections SET completed_at=NOW() - interval '2 days' WHERE id=${id}`],
  ]) {
    await refuses(db, sql, 'is immutable');
    void what;
  }
});

test('an out-of-service report cannot be quietly flipped to passing', async () => {
  // The one that would matter most: a unit is parked by a major defect, and
  // the cheapest way to un-park it would be to edit the report that parked it.
  const db = await freshDb();
  const { id } = await signedInspection(db, { severity: 'major' });
  await refuses(db, `UPDATE inspections SET status='complete' WHERE id=${id}`,
    'may only be superseded');
  await refuses(db, `UPDATE inspections SET status='in_progress' WHERE id=${id}`);
});

test('submitted_at and deleted_at are write-once', async () => {
  const db = await freshDb();
  const { id } = await signedInspection(db);
  await refuses(db, `UPDATE inspections SET submitted_at=NOW() + interval '1 day' WHERE id=${id}`,
    'write-once');
  await db.exec(`UPDATE inspections SET deleted_at=NOW() WHERE id=${id}`);
  await refuses(db, `UPDATE inspections SET deleted_at=NOW() + interval '1 day' WHERE id=${id}`,
    'write-once');
});

test('the defect list of a signed report cannot be added to or deleted from', async () => {
  // The defect list IS the report. Freezing only UPDATE would leave it
  // possible to append a defect to a signed report, or drop one out of it.
  const db = await freshDb();
  const { id, spare } = await signedInspection(db);
  await refuses(db,
    `INSERT INTO inspection_defects (inspection_id,schedule_item_id,severity)
     VALUES (${id},${spare},'minor')`, 'cannot be added to');
  await refuses(db, `DELETE FROM inspection_defects WHERE inspection_id=${id}`, 'deleted from');
});

test('a defect on a signed report cannot be downgraded, only repaired', async () => {
  const db = await freshDb();
  const { id, A } = await signedInspection(db);
  await refuses(db, `UPDATE inspection_defects SET severity='minor' WHERE inspection_id=${id}`,
    'only the repair resolution');
  await refuses(db, `UPDATE inspection_defects SET note='never mind' WHERE inspection_id=${id}`,
    'only the repair resolution');
  // But recording the repair is exactly what an admin is supposed to do.
  await db.exec(`UPDATE inspection_defects SET resolved_at=NOW(), resolved_by=${A},
                   repair_note='Adjusted, road tested' WHERE inspection_id=${id}`);
  const r = await one(db, `SELECT resolved_at FROM inspection_defects WHERE inspection_id=${id}`);
  assert.ok(r.resolved_at);
});

test('a repair cannot be recorded without a note', async () => {
  const db = await freshDb();
  const { id, A } = await signedInspection(db);
  await refuses(db,
    `UPDATE inspection_defects SET resolved_at=NOW(), resolved_by=${A}, repair_note=NULL
       WHERE inspection_id=${id}`, 'resolution_complete');
});

test('superseding, soft-delete and archiving are the permitted afterthoughts', async () => {
  const db = await freshDb();
  const { id } = await signedInspection(db);
  await db.exec(`UPDATE inspections SET status='superseded' WHERE id=${id}`);
  await db.exec(`UPDATE inspections SET deleted_at=NOW()   WHERE id=${id}`);
  // archived_at was added in 061 and had to be taught to the lock — the
  // "freeze anything new" rule would otherwise break the retention job.
  await db.exec(`UPDATE inspections SET archived_at=NOW()  WHERE id=${id}`);
  const r = await one(db, `SELECT status, deleted_at, archived_at FROM inspections WHERE id=${id}`);
  assert.equal(r.status, 'superseded');
  assert.ok(r.deleted_at && r.archived_at);
});

// ─── Offline sync (062) ─────────────────────────────────────────────────────

test('a synced check dates its validity from the driver\'s clock, not the server\'s', async () => {
  const db = await freshDb();
  const V = (await one(db, `SELECT id FROM vehicles WHERE unit_number='T-02'`)).id;
  const S = (await one(db, `SELECT id FROM inspection_schedules WHERE version=1`)).id;
  const E = (await one(db, `SELECT id FROM employees WHERE role='staff'`)).id;
  const { id } = await one(db, `
    INSERT INTO inspections (vehicle_id,schedule_id,carrier_name,plate,plate_jurisdiction,
      inspector_employee_id,inspector_name,client_uuid,started_at)
    VALUES (${V},${S},'HG','CB91031','ON',${E},'D',
            '11111111-2222-4333-8444-555555555555', NOW() - interval '3 hours') RETURNING id`);
  await db.exec(`UPDATE inspections SET completed_at=NOW() - interval '3 hours',
      client_completed_at=NOW() - interval '3 hours', server_received_at=NOW(),
      completed_offline=TRUE, odometer_km=52100, odometer_source='manual',
      location_text='North yard', location_source='device_gps',
      declaration_text='[PLACEHOLDER]', declaration_accepted_at=NOW() - interval '3 hours',
      status='complete', no_defects=TRUE, submitted_at=NOW() WHERE id=${id}`);
  const r = await one(db, `SELECT completed_offline o,
      EXTRACT(EPOCH FROM (valid_until - completed_at))::int s,
      EXTRACT(EPOCH FROM (server_received_at - completed_at))::int delay
      FROM inspections WHERE id=${id}`);
  assert.equal(r.o, true);
  assert.equal(r.s, 86400, 'validity must run from when the driver signed it');
  assert.ok(r.delay > 10000, 'both clocks must be visible on the record');
});

test('a retried sync cannot write a second record of one inspection', async () => {
  // The phone POSTs, the response is lost, the phone retries. Without the
  // unique key that is two legal records of a single inspection.
  const db = await freshDb();
  const V = (await one(db, `SELECT id FROM vehicles WHERE unit_number='T-02'`)).id;
  const S = (await one(db, `SELECT id FROM inspection_schedules WHERE version=1`)).id;
  const A = (await one(db, `SELECT id FROM employees WHERE role='admin'`)).id;
  const ins = `INSERT INTO inspections (vehicle_id,schedule_id,carrier_name,plate,
    plate_jurisdiction,inspector_employee_id,inspector_name,client_uuid)
    VALUES (${V},${S},'HG','CB91031','ON',${A},'D','11111111-2222-4333-8444-555555555555')`;
  await db.exec(ins);
  // The real retry arrives after the first sync has already completed and
  // frozen the report, so the in-progress index is out of the way by then
  // and client_uuid is the only thing standing between one inspection and
  // two records of it. Complete the first to model that.
  await db.exec(`UPDATE inspections SET completed_at=NOW(), status='complete',
     odometer_km=1, odometer_source='manual', location_text='yard',
     location_source='manual', declaration_text='[PLACEHOLDER]',
     declaration_accepted_at=NOW(), no_defects=TRUE
     WHERE client_uuid='11111111-2222-4333-8444-555555555555'`);
  await refuses(db, ins, 'uniq_inspections_client_uuid');
});

test('online checks, which have no client_uuid, do not collide with each other', async () => {
  const db = await freshDb();
  const V = (await one(db, `SELECT id FROM vehicles WHERE unit_number='T-02'`)).id;
  const S = (await one(db, `SELECT id FROM inspection_schedules WHERE version=1`)).id;
  const A = (await one(db, `SELECT id FROM employees WHERE role='admin'`)).id;
  const E = (await one(db, `SELECT id FROM employees WHERE role='staff'`)).id;
  for (const emp of [A, E]) {
    await db.exec(`INSERT INTO inspections (vehicle_id,schedule_id,carrier_name,plate,
      plate_jurisdiction,inspector_employee_id,inspector_name)
      VALUES (${V},${S},'HG','CB91031','ON',${emp},'D')`);
  }
  const r = await one(db, `SELECT COUNT(*)::int n FROM inspections WHERE client_uuid IS NULL`);
  assert.equal(r.n, 2);
});

test('a report cannot claim it was captured offline without showing both clocks', async () => {
  const db = await freshDb();
  const V = (await one(db, `SELECT id FROM vehicles WHERE unit_number='T-02'`)).id;
  const S = (await one(db, `SELECT id FROM inspection_schedules WHERE version=1`)).id;
  const A = (await one(db, `SELECT id FROM employees WHERE role='admin'`)).id;
  await refuses(db,
    `INSERT INTO inspections (vehicle_id,schedule_id,carrier_name,plate,plate_jurisdiction,
       inspector_employee_id,inspector_name,completed_offline)
     VALUES (${V},${S},'HG','CB91031','ON',${A},'D',TRUE)`,
    'offline_has_both_clocks');
});

// ─── Job ledger (061) ───────────────────────────────────────────────────────

test('a scheduled run can be claimed exactly once', async () => {
  // This is the whole double-send guard: two API replicas, or a redeploy
  // mid-window, both race this INSERT and exactly one may win.
  const db = await freshDb();
  const claim = `INSERT INTO scheduled_job_runs (job_name,run_key)
                 VALUES ('inspection-daily-digest','2026-09-01')
                 ON CONFLICT DO NOTHING RETURNING job_name`;
  assert.equal((await db.query(claim)).rows.length, 1, 'first claim should win');
  assert.equal((await db.query(claim)).rows.length, 0, 'second claim must lose');
});

test('different periods are separate claims', async () => {
  const db = await freshDb();
  for (const key of ['2026-09-01', '2026-09-02', '2026-W36', '2026-09']) {
    const r = await db.query(`INSERT INTO scheduled_job_runs (job_name,run_key)
      VALUES ('inspection-daily-digest','${key}') ON CONFLICT DO NOTHING RETURNING job_name`);
    assert.equal(r.rows.length, 1, `period ${key} should be claimable`);
  }
});
