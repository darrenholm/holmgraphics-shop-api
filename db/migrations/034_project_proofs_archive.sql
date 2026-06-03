-- 034_project_proofs_archive.sql
-- Track when a superseded proof's WHC file has been deleted by the
-- nightly archive sweep. The DB row stays forever (for audit + the
-- Messages thread's "📎 Sent proof v3" entry) but the public image
-- gets removed once it's been superseded for 90 days, both to save
-- space and to stop old URLs from being trivially scrape-able.
--
-- archived_at IS NULL  → file still on WHC (active or recently superseded)
-- archived_at SET      → file has been deleted; image_url will 404

ALTER TABLE project_proofs
  ADD COLUMN IF NOT EXISTS archived_at TIMESTAMPTZ;

-- The sweeper queries by status + archived_at + uploaded_at, so a
-- partial index over the candidate set keeps the daily scan cheap
-- even once the table grows.
CREATE INDEX IF NOT EXISTS idx_project_proofs_archive_candidates
  ON project_proofs (uploaded_at)
  WHERE status = 'superseded' AND archived_at IS NULL;
