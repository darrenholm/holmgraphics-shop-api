-- A third vehicle type: equipment.
--
-- The shop's two Skyjack 3219 scissor lifts and the SJ7127 are fleet assets
-- with nowhere to live. They were being typed into a truck's notes field,
-- which means the serial number needed for a warranty claim or a parts order
-- is buried in free text and the hour meter is never written down at all.
--
-- Equipment is NOT a commercial motor vehicle: no plate, no VIN, no
-- registered gross weight, and O. Reg. 199/07 does not reach it. It gets no
-- inspection schedule, so it stays out of the daily circle-check flow on its
-- own — `inspection_schedule_id` is NULL and the offline bundle already
-- filters on that. The inspections scope query is narrowed in routes/ so a
-- lift doesn't show up on the admin board as a unit with "no RGW on file".
--
-- The three new columns hang off `vehicles` rather than a sidecar table:
-- they are three nullable fields, and a join for three fields buys nothing.
-- They are only surfaced in the UI for equipment.
--
-- Safe to re-run.

-- ─── type: allow 'equipment' ─────────────────────────────────────────────
-- Migration 023 declared the CHECK inline on the column, so its name is
-- generated. Find it by definition rather than trusting the generated name.
DO $$
DECLARE c TEXT;
BEGIN
  FOR c IN
    SELECT conname
      FROM pg_constraint
     WHERE conrelid = 'vehicles'::regclass
       AND contype  = 'c'
       AND pg_get_constraintdef(oid) ILIKE '%trailer%'
  LOOP
    EXECUTE format('ALTER TABLE vehicles DROP CONSTRAINT %I', c);
  END LOOP;
END $$;

ALTER TABLE vehicles
  ADD CONSTRAINT vehicles_type_check
  CHECK (type IN ('truck', 'trailer', 'equipment'));

-- ─── equipment columns ───────────────────────────────────────────────────
ALTER TABLE vehicles
  -- Off the data plate. The number every Skyjack parts desk asks for first,
  -- and the only thing telling two identical 3219s apart.
  ADD COLUMN IF NOT EXISTS serial_number TEXT,
  -- Free text, not a number: a lift is rated by two figures that don't
  -- reduce to one unit ("500 lb · 19 ft platform"), and a trailer or a
  -- future forklift would be rated differently again.
  ADD COLUMN IF NOT EXISTS capacity      TEXT,
  -- Hour meter, read off the machine. Tenths, because the meters show them.
  ADD COLUMN IF NOT EXISTS hours         NUMERIC(10,1),
  -- When that reading was taken. An hour count with no date goes stale
  -- silently, and service intervals get planned off it — "412 hours" read
  -- last spring is worse than no number, because it looks current. Set by
  -- the API whenever `hours` changes, so nobody has to maintain it.
  ADD COLUMN IF NOT EXISTS hours_at      TIMESTAMPTZ;

ALTER TABLE vehicles DROP CONSTRAINT IF EXISTS vehicles_hours_nonneg;
ALTER TABLE vehicles
  ADD CONSTRAINT vehicles_hours_nonneg
  CHECK (hours IS NULL OR hours >= 0);

CREATE INDEX IF NOT EXISTS vehicles_type_idx ON vehicles (type);

-- ─── scope trigger: equipment is never a commercial motor vehicle ────────
-- 060 derives inspection_required from RGW alone. A lift has no RGW, so
-- today it lands out of scope by accident rather than on purpose — type a
-- weight into one and the daily board would start asking for a circle
-- check on a scissor lift. Say it outright instead. Same 4,500 kg test as
-- 060 for everything else ("not more than 4,500 kilograms" is excluded, so
-- the threshold is strictly greater).
CREATE OR REPLACE FUNCTION set_vehicle_inspection_required() RETURNS TRIGGER AS $$
BEGIN
  IF NEW.type = 'equipment' THEN
    NEW.inspection_required := FALSE;
    RETURN NEW;
  END IF;
  NEW.inspection_required := COALESCE(NEW.registered_gross_weight_kg, 0) > 4500;
  RETURN NEW;
END $$ LANGUAGE plpgsql;

-- 060 fired this on UPDATE OF registered_gross_weight_kg only. Type is now
-- part of the answer, so a unit re-typed to equipment drops out of scope in
-- that same statement instead of keeping a stale TRUE until someone
-- happens to touch its weight.
DROP TRIGGER IF EXISTS trg_vehicle_inspection_scope ON vehicles;
CREATE TRIGGER trg_vehicle_inspection_scope
  BEFORE INSERT OR UPDATE OF registered_gross_weight_kg, type ON vehicles
  FOR EACH ROW EXECUTE FUNCTION set_vehicle_inspection_required();
