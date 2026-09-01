-- 063_schedule_1_official.sql
--
-- Two changes that arrived together:
--
--   A. The real Schedule 1, transcribed verbatim from the official source,
--      seeded as version 2. Version 1 (placeholders) is left intact and
--      inactive — reports already signed against it must keep pointing at
--      the text they were signed against.
--
--   B. Inspections become on-demand rather than expected daily, per the
--      operator's instruction. See the note under `inspection_policy`.
--
-- Source: O. Reg. 199/07 (Commercial Motor Vehicle Inspections) under the
-- Highway Traffic Act, R.S.O. 1990, c. H.8, retrieved from Ontario e-Laws
-- (ontario.ca/laws/regulation/070199) on 2026-09-01. Consolidation period
-- April 1, 2024 – e-Laws currency date August 27, 2026. Last amendment
-- O. Reg. 118/24. Schedule 1 citation: O. Reg. 199/07, Sched. 1;
-- O. Reg. 242/14, s. 9; O. Reg. 208/18, s. 4.
--
-- ─── Two corrections this makes to migration 060 ──────────────────────
--
-- 1. Schedule 1 is titled "DAILY INSPECTION OF TRUCKS, TRACTORS AND
--    TRAILERS". It covers trailers. Migration 060 assumed a trailer needed
--    a separate schedule and deliberately left trailers unassigned; that
--    was wrong, and there is no separate trailer schedule to seed.
--
-- 2. The regulation has no "items" with a paired minor/major description.
--    It has 23 Parts, each listing lettered minor defects and lettered
--    major defects as separate entries. The placeholder seed invented an
--    item level that does not exist, and the driver UI let the DRIVER pick
--    minor or major — but the regulation already decides which is which.
--    Severity now lives on the row, taken from the column the defect is
--    printed in, and is never chosen by the person doing the check.
--
-- Safe to re-run.

-- ─── A. Schema for the real shape ──────────────────────────────────────

ALTER TABLE inspection_schedule_items
  ADD COLUMN IF NOT EXISTS part_number    INT,
  ADD COLUMN IF NOT EXISTS defect_letter  TEXT,
  ADD COLUMN IF NOT EXISTS severity       TEXT
    CHECK (severity IS NULL OR severity IN ('minor','major')),
  -- Parts 18 and 23 qualify some major defects ("When use of lamps is
  -- required", "At all times"). Dropping that would change what the
  -- regulation says, so it is carried alongside the defect text.
  ADD COLUMN IF NOT EXISTS condition_note TEXT,
  -- Superscript references into the Notes to the schedules (s. 19). Kept
  -- as data rather than baked into the text so the schedule page can show
  -- the note without the defect reading like it has a typo in it.
  ADD COLUMN IF NOT EXISTS footnote_refs  INT[];

-- The notes are part of the schedule the driver has to carry.
CREATE TABLE IF NOT EXISTS inspection_schedule_notes (
  id          SERIAL PRIMARY KEY,
  schedule_id INT  NOT NULL REFERENCES inspection_schedules(id) ON DELETE CASCADE,
  note_number INT  NOT NULL,
  note_text   TEXT NOT NULL,
  UNIQUE (schedule_id, note_number)
);

-- Schedule 1 applies to trucks, tractors AND trailers.
ALTER TABLE inspection_schedules
  DROP CONSTRAINT IF EXISTS inspection_schedules_unit_type_check;
ALTER TABLE inspection_schedules
  ADD CONSTRAINT inspection_schedules_unit_type_check
  CHECK (unit_type IN ('truck','trailer','truck_or_trailer'));

-- ─── B. On-demand inspections ──────────────────────────────────────────
--
-- Operator's instruction, 2026-09-01: circle checks are performed on demand
-- — in practice when pulling a trailer — rather than every operating day.
--
-- This is deliberately a SEPARATE column from `inspection_required`, and
-- neither one overwrites the other:
--
--   inspection_required  derived from RGW. Whether O. Reg. 199/07 applies
--                        to the unit. A fact about the regulation.
--   inspection_policy    how this operator schedules checks. A business
--                        decision, and the only thing the digests, the
--                        overdue counters and the clock-in prompt read.
--
-- Keeping them apart means switching back to 'daily' is one UPDATE, and
-- the admin board can keep showing that a unit is in scope even while the
-- system is not asking for a check on it. Collapsing them into one flag
-- would have erased the regulatory fact to record an operating preference.
ALTER TABLE vehicles
  ADD COLUMN IF NOT EXISTS inspection_policy TEXT NOT NULL DEFAULT 'on_demand'
    CHECK (inspection_policy IN ('daily','on_demand'));

-- Which trailer was attached, if any. Recorded because the stated practice
-- ties checks to towing, and because a trailer drawn by the unit is itself
-- covered by Schedule 1 — so knowing what was behind the truck is part of
-- knowing what was inspected.
ALTER TABLE inspections
  ADD COLUMN IF NOT EXISTS towing_vehicle_id INT REFERENCES vehicles(id);

-- ─── Seed: Schedule 1, version 2, official wording ─────────────────────

INSERT INTO inspection_schedules
  (name, reg_reference, version, unit_type, declaration_text, source_verified, active)
SELECT
  'Schedule 1 — Power Unit',
  'O. Reg. 199/07, Sched. 1',
  2,
  'truck_or_trailer',
  -- s. 7 (1) 8 requires "a statement, signed by the person who conducted
  -- the inspection, that the vehicle was inspected in accordance with this
  -- Regulation". It does NOT prescribe the words, so this wording is ours
  -- and is worded to satisfy that paragraph. Unlike the schedule text
  -- above there is nothing official to copy here.
  'I certify that I have inspected this commercial motor vehicle, and any trailer drawn by it, '
  || 'in accordance with Ontario Regulation 199/07 and Schedule 1 to that Regulation, and that '
  || 'the defects recorded on this report — or the statement that no major or minor defects were '
  || 'found — are accurate and complete.',
  FALSE,
  TRUE
WHERE NOT EXISTS (
  SELECT 1 FROM inspection_schedules WHERE name = 'Schedule 1 — Power Unit' AND version = 2
);

INSERT INTO inspection_schedule_items
  (schedule_id, part_number, group_name, defect_letter, item_label, severity,
   condition_note, footnote_refs, sort_order)
SELECT s.id, v.part_number, v.group_name, v.defect_letter, v.item_label, v.severity,
       v.condition_note, v.footnote_refs, v.part_number * 100 + v.within
  FROM inspection_schedules s
  CROSS JOIN (VALUES
    -- part, group, letter, text, severity, condition, footnotes, order-within-part
    (1,'Air Brake System','a','audible air leak.','minor',NULL,NULL::int[],1),
    (1,'Air Brake System','b','slow air pressure build-up rate.','minor',NULL,NULL,2),
    (1,'Air Brake System','a','pushrod stroke of any brake exceeds the adjustment limit.','major',NULL,ARRAY[1],3),
    (1,'Air Brake System','b','air loss rate exceeds prescribed limit.','major',NULL,ARRAY[2],4),
    (1,'Air Brake System','c','inoperative towing vehicle (tractor) protection system.','major',NULL,NULL,5),
    (1,'Air Brake System','d','low air warning system fails or system is activated.','major',NULL,NULL,6),
    (1,'Air Brake System','e','inoperative service, parking or emergency brake.','major',NULL,NULL,7),

    (2,'Cab','a','occupant compartment door fails to open.','minor',NULL,NULL,1),
    (2,'Cab','a','any cab or sleeper door fails to close securely.','major',NULL,NULL,2),

    (3,'Cargo Securement','a','insecure or improper load covering.','minor',NULL,NULL,1),
    (3,'Cargo Securement','a','insecure cargo.','major',NULL,NULL,2),
    (3,'Cargo Securement','b','absence, failure, malfunction or deterioration of required cargo securement device or load covering.','major',NULL,ARRAY[3],3),

    (4,'Coupling Devices','a','coupler or mounting has loose or missing fastener.','minor',NULL,NULL,1),
    (4,'Coupling Devices','a','coupler is insecure or movement exceeds prescribed limit.','major',NULL,ARRAY[4],2),
    (4,'Coupling Devices','b','coupling or locking mechanism is damaged or fails to lock.','major',NULL,NULL,3),
    (4,'Coupling Devices','c','defective, incorrect or missing safety chain or cable.','major',NULL,NULL,4),

    (5,'Dangerous Goods','a','dangerous goods requirements not met.','major',NULL,ARRAY[5],1),

    (6,'Driver Controls','a','accelerator pedal, clutch, gauges, audible and visual indicators or instruments fail to function properly.','minor',NULL,NULL,1),

    (7,'Driver Seat','a','seat is damaged or fails to remain in set position.','minor',NULL,NULL,1),
    (7,'Driver Seat','a','seatbelt or tether belt is insecure, missing or malfunctions.','major',NULL,NULL,2),

    (8,'Electric Brake System','a','loose or insecure wiring or electrical connection.','minor',NULL,NULL,1),
    (8,'Electric Brake System','a','inoperative breakaway device.','major',NULL,NULL,2),
    (8,'Electric Brake System','b','inoperative brake.','major',NULL,NULL,3),

    (9,'Emergency Equipment and Safety Devices','a','emergency equipment is missing, damaged or defective.','minor',NULL,NULL,1),

    (10,'Exhaust System','a','exhaust leak, except as described in Column 3.','minor',NULL,NULL,1),
    (10,'Exhaust System','a','leak that causes exhaust gas to enter the occupant compartment.','major',NULL,NULL,2),

    (11,'Frame and Cargo Body','a','damaged frame or cargo body.','minor',NULL,NULL,1),
    (11,'Frame and Cargo Body','a','visibly shifted, cracked, collapsing or sagging frame member.','major',NULL,NULL,2),

    (12,'Fuel System','a','missing fuel tank cap.','minor',NULL,NULL,1),
    (12,'Fuel System','a','insecure fuel tank.','major',NULL,NULL,2),
    (12,'Fuel System','b','dripping fuel leak.','major',NULL,NULL,3),

    (13,'General','a','serious damage or deterioration that is noticeable and may affect the vehicle’s safe operation.','major',NULL,NULL,1),

    (14,'Glass and Mirrors','a','required mirror or window glass fails to provide the required view to the driver as a result of being cracked, broken, damaged, missing or maladjusted.','minor',NULL,ARRAY[6,7],1),
    (14,'Glass and Mirrors','b','required mirror or glass has broken or damaged attachments onto vehicle body.','minor',NULL,ARRAY[6],2),

    (15,'Heater / Defroster','a','control or system failure.','minor',NULL,NULL,1),
    (15,'Heater / Defroster','a','defroster fails to provide unobstructed view through the windshield.','major',NULL,NULL,2),

    (16,'Horn','a','vehicle has no operative horn.','minor',NULL,NULL,1),

    (17,'Hydraulic Brake System','a','brake fluid level is below indicated minimum level.','minor',NULL,NULL,1),
    (17,'Hydraulic Brake System','a','brake boost or power assist is not operative.','major',NULL,NULL,2),
    (17,'Hydraulic Brake System','b','brake fluid leak.','major',NULL,NULL,3),
    (17,'Hydraulic Brake System','c','brake pedal fade or insufficient brake pedal reserve.','major',NULL,NULL,4),
    (17,'Hydraulic Brake System','d','activated (other than ABS) warning device.','major',NULL,NULL,5),
    (17,'Hydraulic Brake System','e','brake fluid reservoir is less than ¼ full.','major',NULL,NULL,6),
    (17,'Hydraulic Brake System','f','parking brake is inoperative.','major',NULL,NULL,7),

    (18,'Lamps and Reflectors','a','required lamp does not function as intended.','minor',NULL,ARRAY[8],1),
    (18,'Lamps and Reflectors','b','required reflector is missing or partially missing.','minor',NULL,ARRAY[9],2),
    (18,'Lamps and Reflectors','a','failure of both low-beam headlamps.','major','When use of lamps is required',NULL,3),
    (18,'Lamps and Reflectors','b','failure of both rearmost tail lamps.','major','When use of lamps is required',NULL,4),
    (18,'Lamps and Reflectors','a','failure of a rearmost turn-indicator lamp.','major','At all times',NULL,5),
    (18,'Lamps and Reflectors','b','failure of both rearmost brake lamps.','major','At all times',NULL,6),

    (19,'Steering','a','steering wheel lash (free-play) is greater than normal.','minor',NULL,NULL,1),
    (19,'Steering','a','steering wheel is insecure, or does not respond normally.','major',NULL,NULL,2),
    (19,'Steering','b','steering wheel lash (free-play) exceeds prescribed limit.','major',NULL,ARRAY[10],3),

    (20,'Suspension System','a','air leak in air suspension system.','minor',NULL,NULL,1),
    (20,'Suspension System','b','a broken spring leaf.','minor',NULL,NULL,2),
    (20,'Suspension System','c','suspension fastener is loose, missing or broken.','minor',NULL,NULL,3),
    (20,'Suspension System','a','damaged (patched, cut, bruised, cracked to braid or deflated) air bag or insecurely mounted air bag.','major',NULL,NULL,4),
    (20,'Suspension System','b','cracked or broken main spring leaf or more than one broken spring leaf in any spring assembly.','major',NULL,NULL,5),
    (20,'Suspension System','c','part of spring leaf or suspension is missing, shifted out of place or is in contact with another vehicle component.','major',NULL,NULL,6),
    (20,'Suspension System','d','loose U-bolt.','major',NULL,NULL,7),

    (21,'Tires','a','damaged tread or sidewall of tire.','minor',NULL,NULL,1),
    (21,'Tires','b','tire leaking, if leak cannot be heard.','minor',NULL,NULL,2),
    (21,'Tires','a','flat tire.','major',NULL,NULL,3),
    (21,'Tires','a.1','tire leaking, if leak can be felt or heard.','major',NULL,NULL,4),
    (21,'Tires','b','tire tread depth is less than wear limit.','major',NULL,ARRAY[11],5),
    (21,'Tires','c','tire is in contact with another tire or any vehicle component other than mud-flap.','major',NULL,NULL,6),
    (21,'Tires','d','tire is marked “Not for highway use”.','major',NULL,NULL,7),
    (21,'Tires','e','tire has exposed cords in the tread or outer sidewall area.','major',NULL,NULL,8),

    (22,'Wheels, Hubs and Fasteners','a','hub oil below minimum level (when fitted with sight glass).','minor',NULL,NULL,1),
    (22,'Wheels, Hubs and Fasteners','b','leaking wheel seal.','minor',NULL,NULL,2),
    (22,'Wheels, Hubs and Fasteners','a','wheel has loose, missing or ineffective fastener.','major',NULL,NULL,3),
    (22,'Wheels, Hubs and Fasteners','b','damaged, cracked or broken wheel, rim or attaching part.','major',NULL,NULL,4),
    (22,'Wheels, Hubs and Fasteners','c','evidence of imminent wheel, hub or bearing failure.','major',NULL,NULL,5),

    (23,'Windshield Wiper / Washer','a','control or system malfunction.','minor',NULL,NULL,1),
    (23,'Windshield Wiper / Washer','b','wiper blade is damaged, missing or fails to adequately clear driver’s field of vision.','minor',NULL,NULL,2),
    (23,'Windshield Wiper / Washer','a','wiper or washer fails to adequately clear driver’s field of vision in area swept by driver’s side wiper.','major','When use of wipers or washer is required',NULL,3)
  ) AS v(part_number, group_name, defect_letter, item_label, severity, condition_note, footnote_refs, within)
 WHERE s.name = 'Schedule 1 — Power Unit'
   AND s.version = 2
   AND NOT EXISTS (SELECT 1 FROM inspection_schedule_items i WHERE i.schedule_id = s.id);

-- Notes to the schedules (s. 19), limited to those Schedule 1 refers to.
INSERT INTO inspection_schedule_notes (schedule_id, note_number, note_text)
SELECT s.id, v.n, v.t
  FROM inspection_schedules s
  CROSS JOIN (VALUES
    (1,'Adjustment limits are in section 5 of Regulation 587 of the Revised Regulations of Ontario, 1990 (Equipment) made under the Act.'),
    (2,'Air loss rate limit is prescribed by Schedule 7 to this Regulation.'),
    (3,'Cargo securement device and load covering requirements are prescribed by section 111 of the Act and by Ontario Regulation 363/04 (Security of Loads) made under the Act and Regulation 577 of the Revised Regulations of Ontario, 1990 (Covering of Loads) made under the Act.'),
    (4,'Prescribed limit is 12.7 mm of fore and aft horizontal movement between the upper and lower halves of the fifth wheel assembly.'),
    (5,'Requirements are under the Dangerous Goods Transportation Act and the Transportation of Dangerous Goods Act, 1992 (Canada).'),
    (6,'Mirror requirements are in section 66 of the Act.'),
    (7,'View requirements are in sections 66 and 74 of the Act and in section 1 of Schedule 7 to this Regulation.'),
    (8,'Lamp requirements are in section 62 of the Act.'),
    (9,'Reflector requirements are in section 103 of the Act.'),
    (10,'Steering lash (free play) limit is prescribed by Schedule 7 to this Regulation.'),
    (11,'Wear limit is prescribed by section 3 of Regulation 625 of the Revised Regulations of Ontario, 1990 (Tire Standards and Specifications) made under the Act.')
  ) AS v(n, t)
 WHERE s.name = 'Schedule 1 — Power Unit' AND s.version = 2
   AND NOT EXISTS (SELECT 1 FROM inspection_schedule_notes x WHERE x.schedule_id = s.id);

-- ─── Cut over ──────────────────────────────────────────────────────────
-- Version 1 stops being offered for new checks. It is NOT deleted: reports
-- signed against it point at it, and their text must not move.
UPDATE inspection_schedules
   SET active = FALSE
 WHERE name = 'Schedule 1 — Power Unit' AND version = 1;

-- Every active unit — trucks AND trailers — points at version 2.
UPDATE vehicles v
   SET inspection_schedule_id = s.id
  FROM inspection_schedules s
 WHERE s.name = 'Schedule 1 — Power Unit'
   AND s.version = 2
   AND v.active = TRUE
   AND (v.inspection_schedule_id IS NULL OR v.inspection_schedule_id <> s.id);

-- Existing drafts move to v2 as well; a draft has not been signed, so
-- nothing is being rewritten. Completed reports are left alone — the
-- immutability trigger would refuse them anyway, which is the point.
UPDATE inspections i
   SET schedule_id = s.id
  FROM inspection_schedules s
 WHERE s.name = 'Schedule 1 — Power Unit'
   AND s.version = 2
   AND i.completed_at IS NULL
   AND i.schedule_id <> s.id;
