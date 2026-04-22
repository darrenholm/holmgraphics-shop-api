-- 004_clients_files_folder.sql
-- Manual folder-match override for the files-bridge.
--
-- The files-bridge normally auto-resolves the NAS folder from the DB's
-- client_name (COALESCE(c.company, c.fname || c.lname)). Staff can override
-- that on the job detail screen when the auto-match is wrong or missing;
-- the chosen folder name goes here.
--
-- NULL means "no override — let the bridge auto-resolve."
-- When set, the shop API returns this as the client_folder_name field used
-- when calling the bridge.
--
-- Safe to re-run.

ALTER TABLE clients
  ADD COLUMN IF NOT EXISTS files_folder TEXT;

-- Non-unique index so /api/clients/folder-mappings can cheaply fetch
-- everyone with an override (for the "already used by" warning in the
-- folder picker).
CREATE INDEX IF NOT EXISTS clients_files_folder_idx
  ON clients (files_folder)
  WHERE files_folder IS NOT NULL;
