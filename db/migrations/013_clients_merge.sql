-- 013_clients_merge.sql
-- Adds the soft-delete + merge-pointer columns that POST /api/clients/:id/merge
-- writes to. Soft-delete (rather than DELETE) keeps the audit trail intact
-- and leaves room for a future "unmerge" feature.
--
--   merged_into_id  → if set, this client was absorbed into the row at id.
--                     Frontend filters these out of the default list view;
--                     a "Show merged" toggle un-filters them.
--   archived_at     → when the merge ran. Kept distinct from clients.updated_at
--                     since the per-row updated_at trigger fires on any
--                     UPDATE, not just the merge action.
--
-- Safe to re-run.

ALTER TABLE clients
  ADD COLUMN IF NOT EXISTS merged_into_id INT REFERENCES clients(id),
  ADD COLUMN IF NOT EXISTS archived_at    TIMESTAMPTZ;

-- Partial index on the merge pointer -- the vast majority of clients are
-- non-merged, so a full index would be wasted bytes. The "show merged"
-- toggle's WHERE merged_into_id IS NOT NULL hits this index.
CREATE INDEX IF NOT EXISTS clients_merged_into_idx
  ON clients (merged_into_id)
  WHERE merged_into_id IS NOT NULL;
