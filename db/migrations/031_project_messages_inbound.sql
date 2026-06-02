-- 031_project_messages_inbound.sql
-- Add columns to project_messages so we can ingest emails sent to
-- reply.holmgraphics.ca (via Cloudflare Email Worker → our webhook).
--
--   inbound_message_id  — the Message-ID header from the inbound email.
--                         Used to dedupe webhook retries (Cloudflare /
--                         Resend retry on 5xx); a unique partial index
--                         guards against double-posting.
--   inbound_from_email  — the raw 'From' address, kept so staff can see
--                         exactly who replied even when the parsed
--                         author_name is just "Customer" or similar.
--
-- Safe to re-run.

ALTER TABLE project_messages
  ADD COLUMN IF NOT EXISTS inbound_message_id TEXT,
  ADD COLUMN IF NOT EXISTS inbound_from_email TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS project_messages_inbound_message_id_idx
  ON project_messages (inbound_message_id)
  WHERE inbound_message_id IS NOT NULL;
