-- 033_project_proofs.sql
-- Per-project proof approval system. Mirrors the proof flow that
-- already exists for DTF online orders (routes/proofs.js) but bound
-- to projects/jobs instead of orders, with version tracking and a
-- JSON column for canvas annotations.
--
-- Customer flow: staff uploads → email with tokenized URL → customer
-- views proof + optionally annotates → approves or requests changes.
-- All responses post into project_messages so the thread is visible
-- alongside everything else.

CREATE TABLE IF NOT EXISTS project_proofs (
  id              SERIAL PRIMARY KEY,
  project_id      INT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  version         INT NOT NULL,                -- 1, 2, 3, ...
  file_path       TEXT NOT NULL,               -- bridge-relative path under the job folder
  file_mime       TEXT NOT NULL DEFAULT 'image/jpeg',
  file_size_bytes BIGINT,

  -- Customer-facing access (no login)
  token             TEXT NOT NULL UNIQUE,
  token_expires_at  TIMESTAMPTZ,                -- optional; NULL = no expiry

  -- Lifecycle. Customer flow:
  --   sent → viewed → approved
  --                 → changes_requested
  status            TEXT NOT NULL DEFAULT 'sent'
    CHECK (status IN ('sent', 'viewed', 'approved', 'changes_requested', 'superseded')),

  -- On approval, optionally bump project.status_id to this value.
  -- NULL = no auto-bump.
  approve_status_id INT,

  -- Audit
  uploaded_by     INT NOT NULL REFERENCES employees(id),
  uploaded_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  sent_to_email   TEXT,                         -- recipient at send time
  first_viewed_at TIMESTAMPTZ,
  responded_at    TIMESTAMPTZ,

  -- Customer response payload
  response_name   TEXT,                         -- typed name (the "signature")
  response_text   TEXT,                         -- optional changes feedback
  response_ip     TEXT,
  response_ua     TEXT,

  -- Annotation JSON. Schema:
  --   [
  --     { type: 'line'|'arrow'|'rect'|'text', points: [[x,y],...],
  --       color, width, text?, author: 'staff'|'customer', author_name?,
  --       created_at: ISO }
  --   ]
  -- Coordinates are in image-pixel space so they scale with display.
  annotations     JSONB NOT NULL DEFAULT '[]'::jsonb,

  UNIQUE (project_id, version)
);

CREATE INDEX IF NOT EXISTS project_proofs_project_idx
  ON project_proofs (project_id, version DESC);

CREATE INDEX IF NOT EXISTS project_proofs_token_idx
  ON project_proofs (token);

CREATE INDEX IF NOT EXISTS project_proofs_status_idx
  ON project_proofs (status, project_id);
