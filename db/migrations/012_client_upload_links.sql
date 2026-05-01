-- 012_client_upload_links.sql
-- Per-job, per-recipient upload tokens for the "client uploads artwork
-- without logging in" flow. Staff hits POST /api/jobs/:id/upload-links
-- with an email; the API mints a row, emails the recipient a public
-- /upload/<token> URL, and the upload page POSTs files back through
-- the file-bridge into the job's L:\...\designs\ folder.
--
-- Single-token, multi-upload semantics: each link can be used up to
-- max_uploads times before it goes inert. Combined with expires_at,
-- that bounds the blast radius of a leaked link.
--
-- Safe to re-run.

CREATE TABLE IF NOT EXISTS client_upload_links (
  id                 SERIAL PRIMARY KEY,
  job_id             INT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  -- UUID-v4 minted by the API. Unique by table-level constraint so a
  -- collision (vanishingly rare) surfaces as 409 rather than silent reuse.
  token              UUID NOT NULL UNIQUE,
  recipient_email    TEXT NOT NULL,
  -- Caller can override defaults at link-create time. used_count cap +
  -- expires_at together cap the blast radius of a leaked link: a
  -- forwarded URL can do at most max_uploads writes before expiring.
  expires_at         TIMESTAMPTZ NOT NULL,
  max_uploads        INT NOT NULL DEFAULT 20 CHECK (max_uploads BETWEEN 1 AND 100),
  used_count         INT NOT NULL DEFAULT 0 CHECK (used_count >= 0),
  -- Audit: which staff member generated the link, and when each side
  -- of the link last did something with it.
  created_by_emp_id  INT,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_used_at       TIMESTAMPTZ
);

-- Token lookups happen on every public request — must be fast.
CREATE INDEX IF NOT EXISTS client_upload_links_token_idx
  ON client_upload_links (token);

-- "Show me all the links a staff member has minted for this job" — used
-- by the future "manage links" UI on the staff job page.
CREATE INDEX IF NOT EXISTS client_upload_links_job_idx
  ON client_upload_links (job_id, created_at DESC);
