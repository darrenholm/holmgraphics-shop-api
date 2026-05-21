-- 023_fleet_documents.sql
-- Holm Graphics fleet document portal.
--
-- Tables:
--   vehicles                     — fleet roster (trucks + trailers)
--   fleet_documents              — ownership / insurance / CVOR scans per vehicle
--   fleet_document_access_log    — append-only audit trail for CVOR compliance
--
-- Naming: the spec calls these `documents` and `document_access_log` but
-- those names are too generic in a shared Postgres schema (we already have
-- `designs`, `proofs`, etc. tied to artwork — calling vehicle docs just
-- `documents` invites future collisions). Prefixing with `fleet_` keeps
-- the namespace clean. `vehicles` stays unprefixed since nothing else owns
-- that noun in this DB.
--
-- File storage: file_path holds the L:\ network-share path served via
-- files-bridge (see lib/files-bridge-client.js). No public URLs — every
-- fetch goes through an authenticated streaming route.
--
-- Trailer / CVOR rule: enforced at the app layer, not the DB, per spec.
-- The doc_type CHECK still permits `cvor` rows for trailers; routes must
-- block this with a 400 + clear message.
--
-- Active document selection: `is_current` flag drives the driver-facing
-- query. A partial unique index guarantees at most one current doc per
-- (vehicle_id, doc_type). Older docs stay in the table for history.
--
-- Audit log: append-only. FKs default to NO ACTION (RESTRICT) on delete
-- so the log can't be torn down by a cascading vehicle/doc deletion.
-- Employees should be deactivated (active=false), never hard-deleted —
-- so this also keeps user_id NOT NULL viable.
--
-- Safe to re-run.

-- ─── vehicles ────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS vehicles (
  id              SERIAL PRIMARY KEY,
  unit_number     TEXT NOT NULL UNIQUE,        -- e.g. 'T-04', 'TR-12'
  type            TEXT NOT NULL CHECK (type IN ('truck', 'trailer')),
  make            TEXT,
  model           TEXT,
  year            INT CHECK (year IS NULL OR (year BETWEEN 1900 AND 2099)),
  license_plate   TEXT,
  vin             TEXT,
  notes           TEXT,
  active          BOOLEAN NOT NULL DEFAULT TRUE,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS vehicles_unit_idx
  ON vehicles (unit_number);

CREATE INDEX IF NOT EXISTS vehicles_active_idx
  ON vehicles (active);

-- Reuse the updated_at trigger function defined in 008/021. Recreate it
-- here so this migration is self-contained against fresh-bootstrap edges.
CREATE OR REPLACE FUNCTION orders_set_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at := NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS vehicles_updated_at_trigger ON vehicles;
CREATE TRIGGER vehicles_updated_at_trigger
  BEFORE UPDATE ON vehicles
  FOR EACH ROW
  EXECUTE FUNCTION orders_set_updated_at();

-- ─── fleet_documents ─────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS fleet_documents (
  id              SERIAL PRIMARY KEY,
  vehicle_id      INT NOT NULL REFERENCES vehicles(id),
  doc_type        TEXT NOT NULL CHECK (doc_type IN ('ownership', 'insurance', 'cvor')),
  file_path       TEXT NOT NULL,                -- L:\HolmGraphics\Fleet\<vehicle_id>\<doc_type>\<uuid>.<ext>
  file_mime       TEXT NOT NULL CHECK (file_mime IN ('image/jpeg', 'image/png', 'application/pdf')),
  file_size_bytes BIGINT,
  issued_date     DATE,
  expiry_date     DATE,
  uploaded_by     INT NOT NULL REFERENCES employees(id),
  uploaded_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  is_current      BOOLEAN NOT NULL DEFAULT TRUE,
  notes           TEXT,
  CONSTRAINT fleet_documents_dates_ok
    CHECK (expiry_date IS NULL OR issued_date IS NULL OR expiry_date >= issued_date)
);

CREATE INDEX IF NOT EXISTS fleet_documents_vehicle_idx
  ON fleet_documents (vehicle_id);

CREATE INDEX IF NOT EXISTS fleet_documents_type_idx
  ON fleet_documents (vehicle_id, doc_type);

-- Partial unique index: at most one current row per (vehicle, doc_type).
-- Uploading a new doc must flip prior is_current to FALSE before inserting
-- the new TRUE row (or use a single transaction with an UPDATE then INSERT).
CREATE UNIQUE INDEX IF NOT EXISTS fleet_documents_one_current_per_type_idx
  ON fleet_documents (vehicle_id, doc_type)
  WHERE is_current = TRUE;

-- Lets the expiry-monitoring dashboard query "expires in the next N days"
-- without scanning the whole table.
CREATE INDEX IF NOT EXISTS fleet_documents_expiry_idx
  ON fleet_documents (expiry_date)
  WHERE is_current = TRUE AND expiry_date IS NOT NULL;

-- ─── fleet_document_access_log ───────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS fleet_document_access_log (
  id              SERIAL PRIMARY KEY,
  user_id         INT NOT NULL REFERENCES employees(id),
  document_id     INT NOT NULL REFERENCES fleet_documents(id),
  action          TEXT NOT NULL CHECK (action IN ('view', 'download')),
  ip_address      TEXT,
  user_agent      TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS fleet_doc_access_log_doc_idx
  ON fleet_document_access_log (document_id, created_at DESC);

CREATE INDEX IF NOT EXISTS fleet_doc_access_log_user_idx
  ON fleet_document_access_log (user_id, created_at DESC);

CREATE INDEX IF NOT EXISTS fleet_doc_access_log_recent_idx
  ON fleet_document_access_log (created_at DESC);
