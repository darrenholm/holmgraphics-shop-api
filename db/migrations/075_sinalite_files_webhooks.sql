-- 075_sinalite_files_webhooks.sql
-- SinaLite ordering groundwork.
--
-- sinalite_files: print-ready PDFs we host for SinaLite to download. Their
-- order API takes a URL per file, and our art lives on L: which they can't
-- reach, so staff upload the PDF here and we serve it from the Railway
-- volume behind an unguessable token. SinaLite asked that files stay up at
-- least a day after printing.
--
-- sinalite_webhook_events: raw order status pushes from SinaLite (SHIPPED
-- etc, with tracking). Kept verbatim so nothing is lost before ordering is
-- wired to jobs.

CREATE TABLE IF NOT EXISTS sinalite_files (
  token          TEXT        PRIMARY KEY,
  project_id     INTEGER     REFERENCES projects(id) ON DELETE SET NULL,
  original_name  TEXT        NOT NULL,
  file_path      TEXT        NOT NULL,
  size_bytes     BIGINT      NOT NULL,
  uploaded_by    INTEGER,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  deleted_at     TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS sinalite_files_project_idx ON sinalite_files (project_id);

CREATE TABLE IF NOT EXISTS sinalite_webhook_events (
  id           SERIAL      PRIMARY KEY,
  received_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  order_id     TEXT,
  status       TEXT,
  tracking     TEXT,
  payload      JSONB       NOT NULL
);
CREATE INDEX IF NOT EXISTS sinalite_webhook_events_order_idx ON sinalite_webhook_events (order_id);
