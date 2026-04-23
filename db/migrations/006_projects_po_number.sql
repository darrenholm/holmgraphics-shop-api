-- 006_projects_po_number.sql
-- Customer PO# for a job. TEXT (not INTEGER) because PO numbers from
-- customers often have letters/prefixes (e.g. "PO-2026-0142", "HC-0391").
-- Nullable — most jobs won't have one at all.
--
-- Not indexed for now; add a partial index later if we build a "find by
-- PO#" lookup or filter on the jobs list.
--
-- Safe to re-run.

ALTER TABLE projects
  ADD COLUMN IF NOT EXISTS po_number TEXT;
