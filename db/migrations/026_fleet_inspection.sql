-- 026_fleet_inspection.sql
-- Add 'inspection' (annual safety inspection / PMVI yellow sticker) as a
-- fleet document type. Unlike CVOR, this one applies to BOTH trucks AND
-- trailers — in Ontario CVOR-regulated fleets both classes need a current
-- PMVI certificate.
--
-- Safe to re-run.

ALTER TABLE fleet_documents
  DROP CONSTRAINT IF EXISTS fleet_documents_doc_type_check;

ALTER TABLE fleet_documents
  ADD CONSTRAINT fleet_documents_doc_type_check
  CHECK (doc_type IN ('ownership', 'insurance', 'cvor', 'inspection'));
