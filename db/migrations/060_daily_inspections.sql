-- 060_daily_inspections.sql
-- Daily vehicle inspection ("circle check") — O. Reg. 199/07 under the
-- Ontario Highway Traffic Act.
--
-- This is NOT a checklist feature. A completed row here is the legal record
-- an MTO officer asks for at roadside and the document a CVOR audit samples
-- six months later. Three rules drive the shape of everything below:
--
--   1. A signed report must be reproducible EXACTLY as signed. Every
--      legally-required value is snapshotted onto the inspections row at
--      completion — carrier name, plate, jurisdiction, inspector name,
--      declaration wording. Never resolved through a FK at render time.
--      Re-plating a truck or renaming the carrier must not retroactively
--      rewrite a report someone already signed.
--   2. Completed reports are immutable (trg_inspection_lock below). A
--      correction is a NEW report that supersedes the old one; both are
--      kept.
--   3. Soft-delete only. Reports are retained 6 months minimum, 2 years if
--      a repair was linked to them. Nothing here ever gets hard-deleted.
--
-- Departures from the original build spec, and why:
--   * The spec was written against Supabase (uuid PKs, RLS, auth.uid()).
--     This API is Express + node-postgres on Railway with a staff JWT, so
--     PKs are SERIAL to match every other table and authorization lives in
--     route middleware (requireStaff / requireAdmin), not RLS.
--   * The spec adds vehicles.unit_type; vehicles.type already exists with
--     the same ('truck','trailer') check (migration 023). Reused it rather
--     than creating a second competing column.
--   * The spec makes valid_until a GENERATED column. It can't be —
--     `timestamptz + interval` is STABLE, not IMMUTABLE, so Postgres
--     rejects the generation expression. It's derived by a BEFORE trigger
--     instead, which keeps it equally un-hand-settable.
--
-- Safe to re-run.

-- ─── Schedule definitions ──────────────────────────────────────────────
-- Seeded and versioned, not edited in place. When the official wording is
-- confirmed, insert version 2 rather than UPDATE-ing version 1 — reports
-- already signed against v1 must keep pointing at the text they were
-- signed against.
CREATE TABLE IF NOT EXISTS inspection_schedules (
  id             SERIAL      PRIMARY KEY,
  name           TEXT        NOT NULL,           -- 'Schedule 1 — Power Unit'
  reg_reference  TEXT        NOT NULL,           -- 'O. Reg. 199/07, Sch. 1'
  version        INT         NOT NULL DEFAULT 1,
  -- Applies to trucks or trailers. Trailers over 4,500 kg get their own
  -- schedule, separate from the power unit's Schedule 1.
  unit_type      TEXT        NOT NULL DEFAULT 'truck'
                             CHECK (unit_type IN ('truck', 'trailer')),

  -- The signed statement the driver accepts. Versioned WITH the schedule
  -- because the declaration references the schedule by name, and snapshotted
  -- onto each inspection at completion.
  declaration_text TEXT,

  -- FALSE until someone with the CVOR file has confirmed every item label
  -- and defect description against the official MTO source. The driver UI
  -- shows an unmissable banner while this is FALSE, and the admin board
  -- refuses to call the feature production-ready. Carriers may ADD items to
  -- Schedule 1 but may not drop any, so a paraphrase is not good enough.
  source_verified  BOOLEAN   NOT NULL DEFAULT FALSE,
  verified_by      INT       REFERENCES employees(id) ON DELETE SET NULL,
  verified_at      TIMESTAMPTZ,

  active         BOOLEAN     NOT NULL DEFAULT TRUE,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT inspection_schedules_name_version UNIQUE (name, version)
);

CREATE TABLE IF NOT EXISTS inspection_schedule_items (
  id                SERIAL  PRIMARY KEY,
  schedule_id       INT     NOT NULL REFERENCES inspection_schedules(id) ON DELETE CASCADE,
  group_name        TEXT    NOT NULL,            -- 'Tires', 'Lamps and Reflectors'
  item_label        TEXT    NOT NULL,            -- 'Tread depth'
  sort_order        INT     NOT NULL DEFAULT 0,
  -- Regulation wording shown to the driver when they flag the item.
  minor_defect_text TEXT,
  -- NULL means this item has no major-defect class — it can only ever be
  -- flagged minor, and can never put the unit out of service.
  major_defect_text TEXT,
  active            BOOLEAN NOT NULL DEFAULT TRUE
);
CREATE INDEX IF NOT EXISTS idx_inspection_items_schedule
  ON inspection_schedule_items(schedule_id, sort_order);

-- ─── Vehicle columns ───────────────────────────────────────────────────
-- O. Reg. 199/07 excludes a commercial motor vehicle "having a gross weight
-- or registered gross weight of not more than 4,500 kilograms." The test is
-- the POWER UNIT's own weight/RGW, not the combination — towing a trailer
-- does not by itself pull a truck into scope.
--
-- RGW changes at the plate counter, not in the shop, so inspection_required
-- is DERIVED from it by trigger rather than hand-set. Re-plate a unit, set
-- the new RGW, and scope re-evaluates itself.
ALTER TABLE vehicles
  ADD COLUMN IF NOT EXISTS registered_gross_weight_kg INT,
  ADD COLUMN IF NOT EXISTS vehicle_weight_kg          INT,
  ADD COLUMN IF NOT EXISTS inspection_required        BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS inspection_schedule_id     INT REFERENCES inspection_schedules(id),
  ADD COLUMN IF NOT EXISTS plate_jurisdiction         TEXT NOT NULL DEFAULT 'ON';

-- ─── The report ────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS inspections (
  id            SERIAL PRIMARY KEY,
  vehicle_id    INT NOT NULL REFERENCES vehicles(id),
  schedule_id   INT NOT NULL REFERENCES inspection_schedules(id),

  -- ── Snapshotted legal fields (O. Reg. 199/07 required content) ──
  -- Frozen at completion. Do not join these out of live tables.
  carrier_name          TEXT NOT NULL,
  plate                 TEXT NOT NULL,
  plate_jurisdiction    TEXT NOT NULL,
  inspector_employee_id INT  NOT NULL REFERENCES employees(id),
  inspector_name        TEXT NOT NULL,
  -- Only populated where the driver did NOT perform the inspection. The
  -- regulation requires the driver's signature in that case.
  driver_employee_id    INT  REFERENCES employees(id),
  driver_signature_name TEXT,
  driver_signature_at   TIMESTAMPTZ,

  started_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  completed_at  TIMESTAMPTZ,
  -- Reports are valid for 24 hours from completion. Derived by trigger.
  valid_until   TIMESTAMPTZ,
  -- Drivers must submit to the carrier within 20 days of validity expiring.
  -- In-app completion satisfies that immediately, but the timestamp is
  -- recorded so the audit trail can show it.
  submitted_at  TIMESTAMPTZ,

  location_lat    NUMERIC(9,6),
  location_lng    NUMERIC(9,6),
  location_text   TEXT,
  location_source TEXT CHECK (location_source IN ('telematics','device_gps','manual')),

  -- Provenance is the whole point: a number with no source is worth less in
  -- an audit than a manual number that says it was manual.
  odometer_km         INT,
  odometer_source     TEXT CHECK (odometer_source IN ('telematics','manual')),
  odometer_reading_at TIMESTAMPTZ,          -- when the telematics sample was taken

  no_defects              BOOLEAN NOT NULL DEFAULT FALSE,
  declaration_text        TEXT,
  declaration_accepted_at TIMESTAMPTZ,

  -- What the driver was shown and acknowledged at the moment of the check:
  -- expired or expiring vehicle documents, an odometer reading lower than
  -- the previous report's, a stale telematics sample. A lapsed insurance
  -- slip does NOT block the check — blocking would push the driver back to
  -- paper and lose the record entirely — but the audit trail has to show
  -- they were told. Array of { type, severity, message, ... }.
  warnings JSONB NOT NULL DEFAULT '[]'::jsonb,

  status TEXT NOT NULL DEFAULT 'in_progress'
    CHECK (status IN ('in_progress','complete','out_of_service','superseded')),
  -- A correction never edits the original; it points back at it.
  supersedes_id INT REFERENCES inspections(id),

  deleted_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  -- A completed report is a legal document; it cannot be missing required
  -- content. Odometer stays required even when telematics is down — the
  -- driver reads it off the dash and it's flagged 'manual'.
  CONSTRAINT inspections_complete_has_required_fields CHECK (
    completed_at IS NULL OR (
      declaration_text        IS NOT NULL AND
      declaration_accepted_at IS NOT NULL AND
      odometer_km             IS NOT NULL AND
      odometer_source         IS NOT NULL
    )
  ),
  -- in_progress means not yet completed, and vice versa.
  CONSTRAINT inspections_status_matches_completion CHECK (
    (status = 'in_progress') = (completed_at IS NULL)
  )
);

CREATE TABLE IF NOT EXISTS inspection_defects (
  id               SERIAL PRIMARY KEY,
  inspection_id    INT  NOT NULL REFERENCES inspections(id) ON DELETE CASCADE,
  schedule_item_id INT  NOT NULL REFERENCES inspection_schedule_items(id),
  severity         TEXT NOT NULL CHECK (severity IN ('minor','major')),
  note             TEXT,
  -- Relative path on the Railway Volume (lib/fleet-storage.js), never a
  -- public URL — photos stream back through an authenticated endpoint the
  -- same way vehicle documents do.
  photo_path       TEXT,
  photo_mime       TEXT,
  -- Set when this defect was carried forward from a previous inspection
  -- that the driver did not resolve.
  carried_from_id  INT  REFERENCES inspection_defects(id),

  -- Only an admin closes a defect, and only with a repair note. A major
  -- defect blocks the unit until this is filled in.
  resolved_at      TIMESTAMPTZ,
  resolved_by      INT REFERENCES employees(id),
  repair_note      TEXT,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  CONSTRAINT inspection_defects_resolution_complete CHECK (
    resolved_at IS NULL OR (resolved_by IS NOT NULL AND repair_note IS NOT NULL)
  )
);

CREATE INDEX IF NOT EXISTS idx_inspections_vehicle_completed
  ON inspections (vehicle_id, completed_at DESC);
CREATE INDEX IF NOT EXISTS idx_inspections_valid_until
  ON inspections (valid_until) WHERE status = 'complete';
CREATE INDEX IF NOT EXISTS idx_inspections_out_of_service
  ON inspections (vehicle_id) WHERE status = 'out_of_service';
CREATE INDEX IF NOT EXISTS idx_inspection_defects_open
  ON inspection_defects (inspection_id) WHERE resolved_at IS NULL;

-- One defect per schedule item per report. A driver flagging "Tread depth"
-- twice is a double-tap, not two findings; the second write updates the
-- first instead of producing a report that contradicts itself.
CREATE UNIQUE INDEX IF NOT EXISTS uniq_inspection_defect_item
  ON inspection_defects (inspection_id, schedule_item_id);

-- One open check per driver per unit. Re-opening /fleet/check resumes the
-- existing draft instead of littering the table with abandoned rows.
CREATE UNIQUE INDEX IF NOT EXISTS uniq_inspection_in_progress
  ON inspections (vehicle_id, inspector_employee_id)
  WHERE status = 'in_progress' AND deleted_at IS NULL;

-- ─── Derived: valid_until ──────────────────────────────────────────────
-- Not a GENERATED column: `timestamptz + interval` is STABLE (DST-dependent),
-- and Postgres only accepts IMMUTABLE generation expressions. A BEFORE
-- trigger gets the same guarantee — callers cannot set it by hand, because
-- whatever they send is overwritten.
CREATE OR REPLACE FUNCTION set_inspection_valid_until() RETURNS TRIGGER AS $$
BEGIN
  NEW.valid_until := CASE
    WHEN NEW.completed_at IS NULL THEN NULL
    ELSE NEW.completed_at + INTERVAL '24 hours'
  END;
  RETURN NEW;
END $$ LANGUAGE plpgsql;

-- ─── Immutability ──────────────────────────────────────────────────────
-- Once completed_at is set the row is frozen, except for three pieces of
-- bookkeeping the carrier is legally allowed to do afterwards:
--   * status → 'superseded'  (a corrected report replaced this one)
--   * submitted_at           (write-once; driver handed it to the carrier)
--   * deleted_at             (write-once; soft delete, never a hard delete)
-- Everything else raises. The check is a whole-row comparison rather than a
-- column list so that adding a column later cannot silently open a hole.
CREATE OR REPLACE FUNCTION lock_completed_inspection() RETURNS TRIGGER AS $$
BEGIN
  -- Still a draft: the inspector may edit freely, including the update that
  -- sets completed_at and freezes the row.
  IF OLD.completed_at IS NULL THEN
    RETURN NEW;
  END IF;

  -- Compare the two rows as jsonb with the three legitimately-mutable keys
  -- subtracted out. Done this way rather than column-by-column so that a
  -- column added later is frozen by default instead of quietly unguarded —
  -- and as jsonb rather than a composite comparison so it does not depend on
  -- every column type having an equality operator.
  IF (to_jsonb(NEW) - 'status' - 'submitted_at' - 'deleted_at')
     IS DISTINCT FROM
     (to_jsonb(OLD) - 'status' - 'submitted_at' - 'deleted_at') THEN
    RAISE EXCEPTION
      'Completed inspection % is immutable (O. Reg. 199/07 record). Supersede it with a new report instead.',
      OLD.id
      USING ERRCODE = 'restrict_violation';
  END IF;

  IF NEW.status IS DISTINCT FROM OLD.status AND NEW.status <> 'superseded' THEN
    RAISE EXCEPTION
      'Completed inspection % may only be superseded, not moved to %.',
      OLD.id, NEW.status
      USING ERRCODE = 'restrict_violation';
  END IF;

  IF OLD.submitted_at IS NOT NULL AND NEW.submitted_at IS DISTINCT FROM OLD.submitted_at THEN
    RAISE EXCEPTION 'submitted_at on inspection % is write-once.', OLD.id
      USING ERRCODE = 'restrict_violation';
  END IF;

  IF OLD.deleted_at IS NOT NULL AND NEW.deleted_at IS DISTINCT FROM OLD.deleted_at THEN
    RAISE EXCEPTION 'deleted_at on inspection % is write-once.', OLD.id
      USING ERRCODE = 'restrict_violation';
  END IF;

  RETURN NEW;
END $$ LANGUAGE plpgsql;

-- Triggers fire in name order, so 'derive' runs before 'lock' and the lock
-- compares against an already-derived valid_until.
DROP TRIGGER IF EXISTS trg_inspection_derive ON inspections;
CREATE TRIGGER trg_inspection_derive
  BEFORE INSERT OR UPDATE ON inspections
  FOR EACH ROW EXECUTE FUNCTION set_inspection_valid_until();

DROP TRIGGER IF EXISTS trg_inspection_lock ON inspections;
CREATE TRIGGER trg_inspection_lock
  BEFORE UPDATE ON inspections
  FOR EACH ROW EXECUTE FUNCTION lock_completed_inspection();

-- Defects belong to the frozen report too. They stay writable only for the
-- resolution fields, which an admin fills in when the repair is done.
CREATE OR REPLACE FUNCTION lock_completed_inspection_defect() RETURNS TRIGGER AS $$
DECLARE
  is_done BOOLEAN;
BEGIN
  SELECT completed_at IS NOT NULL INTO is_done
    FROM inspections WHERE id = OLD.inspection_id;

  IF NOT COALESCE(is_done, FALSE) THEN
    RETURN NEW;
  END IF;

  -- Same shape as the inspection lock: everything frozen except the three
  -- repair-resolution fields an admin fills in after the fact.
  IF (to_jsonb(NEW) - 'resolved_at' - 'resolved_by' - 'repair_note')
     IS DISTINCT FROM
     (to_jsonb(OLD) - 'resolved_at' - 'resolved_by' - 'repair_note') THEN
    RAISE EXCEPTION
      'Defect % belongs to a completed inspection; only the repair resolution may be recorded.',
      OLD.id
      USING ERRCODE = 'restrict_violation';
  END IF;

  RETURN NEW;
END $$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_inspection_defect_lock ON inspection_defects;
CREATE TRIGGER trg_inspection_defect_lock
  BEFORE UPDATE ON inspection_defects
  FOR EACH ROW EXECUTE FUNCTION lock_completed_inspection_defect();

-- Freezing UPDATE alone would leave the record editable by other means: a
-- defect could be added to a signed report, or quietly deleted out of one.
-- The list of defects IS the report, so both are blocked at the table.
CREATE OR REPLACE FUNCTION guard_completed_inspection_defect_rows() RETURNS TRIGGER AS $$
DECLARE
  target  BIGINT;
  is_done BOOLEAN;
BEGIN
  target := CASE TG_OP WHEN 'DELETE' THEN OLD.inspection_id ELSE NEW.inspection_id END;
  SELECT completed_at IS NOT NULL INTO is_done FROM inspections WHERE id = target;

  IF COALESCE(is_done, FALSE) THEN
    RAISE EXCEPTION
      'Inspection % is complete; its defect list cannot be added to or deleted from.', target
      USING ERRCODE = 'restrict_violation';
  END IF;

  RETURN CASE TG_OP WHEN 'DELETE' THEN OLD ELSE NEW END;
END $$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_inspection_defect_rows ON inspection_defects;
CREATE TRIGGER trg_inspection_defect_rows
  BEFORE INSERT OR DELETE ON inspection_defects
  FOR EACH ROW EXECUTE FUNCTION guard_completed_inspection_defect_rows();

-- ─── Derived: inspection scope from RGW ────────────────────────────────
CREATE OR REPLACE FUNCTION set_vehicle_inspection_required() RETURNS TRIGGER AS $$
BEGIN
  -- "not more than 4,500 kilograms" is excluded, so the threshold is
  -- strictly greater than 4500. A unit plated at exactly 4,500 kg RGW is
  -- out of scope. Unknown RGW is treated as out of scope, and the admin
  -- board surfaces units with no RGW on file so the gap is visible rather
  -- than silently assumed either way.
  NEW.inspection_required := COALESCE(NEW.registered_gross_weight_kg, 0) > 4500;
  RETURN NEW;
END $$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_vehicle_inspection_scope ON vehicles;
CREATE TRIGGER trg_vehicle_inspection_scope
  BEFORE INSERT OR UPDATE OF registered_gross_weight_kg ON vehicles
  FOR EACH ROW EXECUTE FUNCTION set_vehicle_inspection_required();

-- ─── Seed: Schedule 1 (power unit) ─────────────────────────────────────
--
--   ⚠  PLACEHOLDER CONTENT — NOT OFFICIAL MTO WORDING  ⚠
--
-- source_verified is FALSE. The group names below follow the published
-- structure of Schedule 1, but every item label and every minor/major
-- defect description is a placeholder written to exercise the UI, and is
-- marked [PLACEHOLDER] so it cannot be mistaken for regulation text if it
-- ever reaches a printed report.
--
-- Before go-live: have whoever manages the CVOR file transcribe the
-- official Schedule 1 item list and defect descriptions, insert them as
-- version 2, and set source_verified = TRUE. Carriers may add items to
-- Schedule 1 but may not drop any.
INSERT INTO inspection_schedules (name, reg_reference, version, unit_type, declaration_text, source_verified, active)
SELECT
  'Schedule 1 — Power Unit',
  'O. Reg. 199/07, Sch. 1',
  1,
  'truck',
  '[PLACEHOLDER — confirm exact wording with the CVOR file holder before go-live] '
  || 'I certify that I have inspected this commercial motor vehicle in accordance with '
  || 'Ontario Regulation 199/07 and Schedule 1, and that the information recorded on this '
  || 'report is accurate and complete.',
  FALSE,
  TRUE
WHERE NOT EXISTS (
  SELECT 1 FROM inspection_schedules WHERE name = 'Schedule 1 — Power Unit' AND version = 1
);

INSERT INTO inspection_schedule_items
  (schedule_id, group_name, item_label, sort_order, minor_defect_text, major_defect_text)
SELECT s.id, g.group_name, g.item_label, g.sort_order, g.minor_text, g.major_text
  FROM inspection_schedules s
  CROSS JOIN (VALUES
    -- (group_name, item_label, sort_order, minor_defect_text, major_defect_text)
    ('Air Brake System',      'Audible air leak',              10, '[PLACEHOLDER] Minor air leak, system holds pressure.', '[PLACEHOLDER] Audible leak with pressure loss beyond limit.'),
    ('Air Brake System',      'Low air pressure warning',      20, '[PLACEHOLDER] Warning device slow to activate.',        '[PLACEHOLDER] Warning device inoperative.'),
    ('Air Brake System',      'Pushrod travel',                30, '[PLACEHOLDER] Travel approaching adjustment limit.',    '[PLACEHOLDER] Pushrod travel beyond adjustment limit.'),
    ('Cab',                   'Doors and latches',             40, '[PLACEHOLDER] Door hardware damaged but secure.',       NULL),
    ('Cab',                   'Occupant restraints',           50, '[PLACEHOLDER] Seat belt frayed or soiled.',             '[PLACEHOLDER] Seat belt missing or inoperative.'),
    ('Cargo Securement',      'Tiedowns and anchor points',    60, '[PLACEHOLDER] Tiedown worn but within working limit.',  '[PLACEHOLDER] Insufficient or failed securement.'),
    ('Coupling Devices',      'Pintle hook / ball / hitch',    70, '[PLACEHOLDER] Coupling worn, still within tolerance.',  '[PLACEHOLDER] Coupling insecure or damaged.'),
    ('Coupling Devices',      'Safety chains',                 80, '[PLACEHOLDER] Chain link damaged.',                     '[PLACEHOLDER] Safety chain missing or broken.'),
    ('Driver Controls',       'Accelerator, brake, clutch',    90, '[PLACEHOLDER] Control worn or sticking slightly.',      '[PLACEHOLDER] Control inoperative.'),
    ('Driver Seat',           'Seat security',                100, '[PLACEHOLDER] Seat cushion damaged.',                   '[PLACEHOLDER] Seat not securely attached.'),
    ('Electric Brake System', 'Controller and wiring',        110, '[PLACEHOLDER] Wiring insulation damaged.',              '[PLACEHOLDER] Trailer brakes inoperative.'),
    ('Emergency Equipment',   'Fire extinguisher',            120, '[PLACEHOLDER] Gauge not in service range.',             '[PLACEHOLDER] Required extinguisher missing.'),
    ('Emergency Equipment',   'Warning devices / triangles',  130, '[PLACEHOLDER] Device damaged but usable.',              '[PLACEHOLDER] Required warning devices missing.'),
    ('Exhaust System',        'Leaks and mounting',           140, '[PLACEHOLDER] Exhaust component loose.',                '[PLACEHOLDER] Exhaust leaking into the occupant compartment.'),
    ('Frame and Cargo Body',  'Frame members',                150, '[PLACEHOLDER] Surface damage to frame.',                '[PLACEHOLDER] Cracked or sagging frame member.'),
    ('Fuel System',           'Leaks and cap',                160, '[PLACEHOLDER] Fuel cap missing or loose.',              '[PLACEHOLDER] Fuel leaking.'),
    ('General',               'Overall condition',            170, '[PLACEHOLDER] Condition noted, unit remains operable.', NULL),
    ('Glass and Mirrors',     'Windshield',                   180, '[PLACEHOLDER] Chip or crack outside the swept area.',   '[PLACEHOLDER] Damage obstructing the driver''s view.'),
    ('Glass and Mirrors',     'Mirrors',                      190, '[PLACEHOLDER] Mirror cracked but usable.',              '[PLACEHOLDER] Required mirror missing or unusable.'),
    ('Heater / Defroster',    'Defroster operation',          200, '[PLACEHOLDER] Defroster output reduced.',               '[PLACEHOLDER] Defroster inoperative in conditions requiring it.'),
    ('Horn',                  'Horn operation',               210, '[PLACEHOLDER] Horn weak.',                              NULL),
    ('Hydraulic Brake System','Pedal reserve and fluid',      220, '[PLACEHOLDER] Fluid below the full mark.',              '[PLACEHOLDER] Brake failure warning lit, or fluid leaking.'),
    ('Lamps and Reflectors',  'Headlamps',                    230, '[PLACEHOLDER] One required lamp inoperative.',          '[PLACEHOLDER] No operative headlamp.'),
    ('Lamps and Reflectors',  'Stop lamps',                   240, '[PLACEHOLDER] One stop lamp inoperative.',              '[PLACEHOLDER] No operative stop lamp.'),
    ('Lamps and Reflectors',  'Turn signals and hazards',     250, '[PLACEHOLDER] One signal lamp inoperative.',            NULL),
    ('Lamps and Reflectors',  'Clearance and marker lamps',   260, '[PLACEHOLDER] Required lamp inoperative.',              NULL),
    ('Steering',              'Steering wheel free play',     270, '[PLACEHOLDER] Free play noticeable, within limit.',      '[PLACEHOLDER] Free play beyond limit, or steering binding.'),
    ('Steering',              'Linkage and power steering',   280, '[PLACEHOLDER] Power steering fluid seeping.',           '[PLACEHOLDER] Linkage component loose, worn or broken.'),
    ('Suspension System',     'Springs and air bags',         290, '[PLACEHOLDER] Spring or bag showing wear.',             '[PLACEHOLDER] Broken spring leaf or deflated air bag.'),
    ('Tires',                 'Tread depth',                  300, '[PLACEHOLDER] Tread approaching the minimum.',          '[PLACEHOLDER] Tread below the minimum, or exposed cord.'),
    ('Tires',                 'Inflation and damage',         310, '[PLACEHOLDER] Tire under-inflated.',                    '[PLACEHOLDER] Flat tire, or damage exposing the belt.'),
    ('Wheels, Hubs, Fasteners','Wheel fasteners',             320, '[PLACEHOLDER] Fastener seating marked.',                '[PLACEHOLDER] Loose, missing or broken fastener.'),
    ('Wheels, Hubs, Fasteners','Hub oil / grease seals',      330, '[PLACEHOLDER] Seal seeping.',                           '[PLACEHOLDER] Lubricant leaking onto the brake or tire.'),
    ('Windshield Wipers',     'Wipers and washer',            340, '[PLACEHOLDER] Wiper streaking, or washer empty.',       '[PLACEHOLDER] Wiper inoperative in conditions requiring it.')
  ) AS g(group_name, item_label, sort_order, minor_text, major_text)
 WHERE s.name = 'Schedule 1 — Power Unit'
   AND s.version = 1
   AND NOT EXISTS (SELECT 1 FROM inspection_schedule_items i WHERE i.schedule_id = s.id);

-- ─── Seed: vehicle weights from the permits on file ────────────────────
-- Matched on the normalized plate rather than unit_number, because plate is
-- what the permit is keyed to and unit numbering conventions drift ('T-01'
-- vs 'T01'). Only fills a blank — never overwrites an RGW someone has
-- already corrected. The scope trigger derives inspection_required from it.
--
-- On these permits exactly one unit is in scope today: T-02, plated at
-- 6,000 kg RGW. T-01 sits exactly at the 4,500 kg limit and is therefore
-- out of scope, which is a plate-counter decision away from changing.
-- Both trailers have no RGW on file and so are neither in nor out — see the
-- note against Tr-03 below.
UPDATE vehicles v
   SET registered_gross_weight_kg = p.rgw,
       vehicle_weight_kg          = COALESCE(v.vehicle_weight_kg, p.wt)
  FROM (VALUES
    ('BY24956', 4500, 2155),   -- T-01  2023 F-150
    ('CB91031', 6000, 2211),   -- T-02  2024 F-150   → in scope
    ('BW28769', 3000, 2227),   -- T-03  RAM ProMaster
    ('CH38045', 3000, 1968),   -- T-04  Ranger
    ('Y6359Z',  NULL, 1880)    -- Tr-02 14' dump — no RGW set on the permit
    -- Tr-03 (AH681F, 22' flatbed) is the SKYJACK TRAILER. Deliberately not
    -- listed: there is no weight on the permit sheet, and guessing one here
    -- would decide its scope by fiat. It stays NULL, which the admin board
    -- reports as an unknown rather than as a "no". If its RGW turns out to
    -- exceed 4,500 kg it needs its own trailer schedule seeded — Schedule 1
    -- is a power-unit schedule and must not be handed to a trailer.
  ) AS p(plate, rgw, wt)
 WHERE REGEXP_REPLACE(UPPER(COALESCE(v.license_plate, '')), '[^A-Z0-9]', '', 'g')
     = REGEXP_REPLACE(UPPER(p.plate),                       '[^A-Z0-9]', '', 'g')
   AND v.registered_gross_weight_kg IS NULL;

-- Point every in-scope truck at Schedule 1. Trailers are deliberately left
-- unassigned: a trailer over 4,500 kg needs its own schedule seeded, and
-- none of ours currently has an RGW on the permit.
UPDATE vehicles v
   SET inspection_schedule_id = s.id
  FROM inspection_schedules s
 WHERE s.name = 'Schedule 1 — Power Unit'
   AND s.version = 1
   AND v.type = 'truck'
   AND v.inspection_schedule_id IS NULL;

-- Backfill scope for rows the trigger didn't see (it only fires on INSERT
-- or on an UPDATE OF registered_gross_weight_kg).
UPDATE vehicles
   SET inspection_required = COALESCE(registered_gross_weight_kg, 0) > 4500
 WHERE inspection_required IS DISTINCT FROM (COALESCE(registered_gross_weight_kg, 0) > 4500);
