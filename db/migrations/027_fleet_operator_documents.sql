-- 027_fleet_operator_documents.sql
-- CVOR (Commercial Vehicle Operator's Registration) is issued to the
-- operator/business, NOT to individual vehicles. Move it out of the
-- per-vehicle fleet_documents table into a parallel
-- fleet_operator_documents table.
--
-- Migration plan:
--   1. Create fleet_operator_documents (same column shape as
--      fleet_documents minus vehicle_id).
--   2. Copy the most-recent current CVOR row from any vehicle into the
--      new table so the operator's CVOR is immediately visible after
--      deploy. file_path is rewritten to the new convention
--      ('_operator/cvor/<uuid>.<ext>') -- but only conceptually; we
--      preserve the original file_path so the existing file on disk
--      keeps working. file_path doesn't have to live under
--      `_operator/` to be served; resolveAbsolutePath only enforces
--      that it stays inside FLEET_DOCS_DIR.
--   3. Mark all CVOR rows in fleet_documents is_current = FALSE so the
--      per-vehicle CVOR sections are emptied. We don't drop the rows
--      (the access log still references them by id) and we don't drop
--      'cvor' from the CHECK constraint (would invalidate old rows).
--
-- Safe to re-run.

CREATE TABLE IF NOT EXISTS fleet_operator_documents (
  id              SERIAL PRIMARY KEY,
  doc_type        TEXT NOT NULL CHECK (doc_type IN ('cvor')),
  file_path       TEXT NOT NULL,
  file_mime       TEXT NOT NULL CHECK (file_mime IN ('image/jpeg', 'image/png', 'application/pdf')),
  file_size_bytes BIGINT,
  issued_date     DATE,
  expiry_date     DATE,
  uploaded_by     INT NOT NULL REFERENCES employees(id),
  uploaded_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  is_current      BOOLEAN NOT NULL DEFAULT TRUE,
  notes           TEXT,
  CONSTRAINT fleet_operator_documents_dates_ok
    CHECK (expiry_date IS NULL OR issued_date IS NULL OR expiry_date >= issued_date)
);

-- At most one current row per doc_type (currently just 'cvor' but
-- leaves room for additional operator-level docs later, e.g. operating
-- authority, insurance certificate of liability, etc).
CREATE UNIQUE INDEX IF NOT EXISTS fleet_operator_documents_one_current_per_type_idx
  ON fleet_operator_documents (doc_type)
  WHERE is_current = TRUE;

-- One-time backfill: take the most-recent current CVOR (by uploaded_at)
-- across the fleet and seed the operator table. INSERT … SELECT only
-- runs if the destination is empty AND a source row exists, so re-runs
-- are no-ops.
INSERT INTO fleet_operator_documents
  (doc_type, file_path, file_mime, file_size_bytes,
   issued_date, expiry_date, uploaded_by, uploaded_at, is_current, notes)
SELECT
  'cvor', d.file_path, d.file_mime, d.file_size_bytes,
  d.issued_date, d.expiry_date, d.uploaded_by, d.uploaded_at, TRUE, d.notes
  FROM fleet_documents d
 WHERE d.doc_type = 'cvor'
   AND d.is_current = TRUE
   AND NOT EXISTS (
     SELECT 1 FROM fleet_operator_documents WHERE doc_type = 'cvor'
   )
 ORDER BY d.uploaded_at DESC
 LIMIT 1;

-- Retire all per-vehicle CVOR rows so the per-vehicle UI no longer
-- treats any of them as current. Historic rows remain for the audit
-- log; the new code path doesn't read them.
UPDATE fleet_documents
   SET is_current = FALSE
 WHERE doc_type = 'cvor' AND is_current = TRUE;

-- Access log needs to be able to reference EITHER a per-vehicle document
-- OR an operator document. Drop the hard FK and add a `source` column
-- so we can distinguish which table document_id points at. Existing
-- rows are all per-vehicle, so default 'vehicle'.
ALTER TABLE fleet_document_access_log
  DROP CONSTRAINT IF EXISTS fleet_document_access_log_document_id_fkey;

ALTER TABLE fleet_document_access_log
  ADD COLUMN IF NOT EXISTS source TEXT NOT NULL DEFAULT 'vehicle'
    CHECK (source IN ('vehicle', 'operator'));
