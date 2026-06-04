-- 041_fleet_vehicle_resources.sql
-- Two changes that group calendar swimlanes the way staff think about them:
--   1. Move Skyjack from resource_type='vehicle' to 'machine' — it lives
--      on-site and gets dispatched like any other machine, not driven.
--   2. Sync the fleet `vehicles` table into resources so trucks/vans
--      from Fleet show up in the Vehicles swimlane. Mirrors the
--      employees→resources sync from migration 039.

BEGIN;

-- ─── 1. Skyjack → machine ────────────────────────────────────────────
UPDATE resources
   SET resource_type = 'machine'
 WHERE name = 'Skyjack'
   AND resource_type = 'vehicle';

-- ─── 2. Resources ↔ vehicles link ────────────────────────────────────
ALTER TABLE resources
  ADD COLUMN IF NOT EXISTS vehicle_id INT REFERENCES vehicles(id) ON DELETE SET NULL;

CREATE UNIQUE INDEX IF NOT EXISTS uniq_resources_vehicle_id
  ON resources(vehicle_id)
  WHERE vehicle_id IS NOT NULL;

-- ─── 3. Seed: one resource per active fleet vehicle ──────────────────
-- Display name format: "#unit make model" (e.g. "#101 Ford F-150").
-- Strips empty pieces so a vehicle missing make/model doesn't render
-- with awkward double-spaces.
INSERT INTO resources (name, resource_type, daily_capacity_hours, color, notes, vehicle_id)
SELECT
  TRIM(REGEXP_REPLACE(
    CONCAT_WS(' ',
      CASE WHEN v.unit_number IS NOT NULL AND v.unit_number <> ''
           THEN '#' || v.unit_number ELSE NULL END,
      v.make,
      v.model
    ),
    '\s+', ' ', 'g'
  )) AS name,
  'vehicle',
  8.0,
  (ARRAY['#dc2626','#ea580c','#d97706','#16a34a','#0891b2','#9333ea'])[1 + (v.id % 6)],
  'Auto-synced from fleet',
  v.id
FROM vehicles v
WHERE v.active = TRUE
  AND NOT EXISTS (SELECT 1 FROM resources r WHERE r.vehicle_id = v.id)
  AND COALESCE(v.unit_number, v.make, v.model) IS NOT NULL;

-- ─── 4. Keep resources in sync with vehicle changes ──────────────────
CREATE OR REPLACE FUNCTION sync_vehicle_resource() RETURNS TRIGGER AS $$
DECLARE
  v_name TEXT;
BEGIN
  v_name := TRIM(REGEXP_REPLACE(
    CONCAT_WS(' ',
      CASE WHEN NEW.unit_number IS NOT NULL AND NEW.unit_number <> ''
           THEN '#' || NEW.unit_number ELSE NULL END,
      NEW.make,
      NEW.model
    ),
    '\s+', ' ', 'g'
  ));
  -- Empty name = nothing useful to put in the calendar; bail.
  IF v_name = '' THEN
    RETURN NEW;
  END IF;

  IF TG_OP = 'INSERT' THEN
    IF NEW.active = TRUE
       AND NOT EXISTS (SELECT 1 FROM resources WHERE vehicle_id = NEW.id)
    THEN
      INSERT INTO resources (name, resource_type, daily_capacity_hours, color, notes, vehicle_id)
      VALUES (
        v_name, 'vehicle', 8.0,
        (ARRAY['#dc2626','#ea580c','#d97706','#16a34a','#0891b2','#9333ea'])[1 + (NEW.id % 6)],
        'Auto-synced from fleet',
        NEW.id
      );
    END IF;
  ELSIF TG_OP = 'UPDATE' THEN
    UPDATE resources
       SET name   = v_name,
           active = COALESCE(NEW.active, TRUE)
     WHERE vehicle_id = NEW.id;
    -- Resurrection path: vehicle going active for the first time
    -- after this migration would otherwise have no resource row.
    IF NEW.active = TRUE
       AND NOT EXISTS (SELECT 1 FROM resources WHERE vehicle_id = NEW.id)
    THEN
      INSERT INTO resources (name, resource_type, daily_capacity_hours, color, notes, vehicle_id)
      VALUES (
        v_name, 'vehicle', 8.0,
        (ARRAY['#dc2626','#ea580c','#d97706','#16a34a','#0891b2','#9333ea'])[1 + (NEW.id % 6)],
        'Auto-synced from fleet',
        NEW.id
      );
    END IF;
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_vehicle_to_resource_sync ON vehicles;
CREATE TRIGGER trg_vehicle_to_resource_sync
  AFTER INSERT OR UPDATE OF unit_number, make, model, active ON vehicles
  FOR EACH ROW
  EXECUTE FUNCTION sync_vehicle_resource();

COMMIT;
