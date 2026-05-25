-- Per-project chat thread between the customer (clients row) and any
-- staff member (employees row). Both realms write to the same table;
-- author_type discriminates who said what. Email notifications fire
-- when the OTHER party posts so neither side has to poll.
--
-- Read receipts:
--   read_at_customer / read_at_staff stamp the "last read" timestamp
--   per role, NOT per individual employee — fine for v1 since the
--   thread is small (a few staff per project at most). Per-employee
--   read tracking is a future enhancement if it becomes useful.

CREATE TABLE IF NOT EXISTS project_messages (
  id              BIGSERIAL PRIMARY KEY,
  project_id      INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  author_type     TEXT NOT NULL CHECK (author_type IN ('customer', 'staff')),
  -- For customer: clients.id; for staff: employees.id. Nullable for
  -- system messages (status auto-updates, payment receipts) if we ever
  -- post those into the thread.
  author_id       INTEGER,
  author_name     TEXT,                -- snapshot at send time
  body            TEXT NOT NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS project_messages_project_id_idx
  ON project_messages (project_id, created_at DESC);

-- Per-project, per-role "last read" timestamps. One row per project;
-- both timestamps live together so the project-list query for unread
-- counts is a simple join.
CREATE TABLE IF NOT EXISTS project_message_reads (
  project_id        INTEGER PRIMARY KEY REFERENCES projects(id) ON DELETE CASCADE,
  read_at_customer  TIMESTAMPTZ,
  read_at_staff     TIMESTAMPTZ
);
