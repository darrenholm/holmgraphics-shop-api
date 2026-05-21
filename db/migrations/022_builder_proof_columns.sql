-- 022_builder_proof_columns.sql
-- Extend builder_drafts with proof + approval state. After a buyer submits
-- a draft, admin attaches a proof image + payment link and the draft moves
-- through 'submitted' → 'proof_sent' → 'approved'. From 'approved' onwards
-- the buyer pays via the QBO link (outside this system); admin then
-- promotes the draft into a real order/job manually for now.
--
-- Status state machine (full set after this migration):
--   draft       — buyer is still editing in /shop/builder
--   submitted   — buyer clicked "Submit for proof"; admin email fired
--   proof_sent  — admin attached proof + payment link; buyer email fired
--   approved    — buyer clicked Approve on the proof viewer page
--   abandoned   — terminal; idle-cleanup cron flips drafts here after 30d
--
-- Safe to re-run.

-- ─── Status enum: drop and recreate so we can add the two new values ─────────

ALTER TABLE builder_drafts
  DROP CONSTRAINT IF EXISTS builder_drafts_status_check;

ALTER TABLE builder_drafts
  ADD CONSTRAINT builder_drafts_status_check
    CHECK (status IN ('draft', 'submitted', 'proof_sent', 'approved', 'abandoned'));

-- ─── Proof + approval columns ────────────────────────────────────────────────

ALTER TABLE builder_drafts
  ADD COLUMN IF NOT EXISTS proof_image_url   TEXT,
  ADD COLUMN IF NOT EXISTS payment_link_url  TEXT,
  ADD COLUMN IF NOT EXISTS proof_message     TEXT,                 -- admin's note to buyer
  ADD COLUMN IF NOT EXISTS approval_token    TEXT,
  ADD COLUMN IF NOT EXISTS proof_sent_at     TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS proof_sent_by     TEXT,                 -- staff email
  ADD COLUMN IF NOT EXISTS approved_at       TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS approve_email_id  TEXT;                 -- Resend id of admin notice

-- Unique index on approval_token rather than column UNIQUE so it's
-- conditionally enforced (NULL is allowed and not in the unique set).
CREATE UNIQUE INDEX IF NOT EXISTS builder_drafts_approval_token_idx
  ON builder_drafts (approval_token)
  WHERE approval_token IS NOT NULL;
