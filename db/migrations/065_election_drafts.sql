-- 065_election_drafts.sql
--
-- A half-finished election order, saved as it is typed.
--
-- WHY. Candidates ring up partway through: "I'm on the sign bit and I don't
-- know which thickness." Without this, whoever answers the phone is working
-- blind — the order only exists in that person's browser. With it, the caller
-- reads out a short code and staff open the same basket on screen.
--
-- Not a job. A draft is a basket somebody is still thinking about, and putting
-- those on the board would bury the real work. It becomes a job only when they
-- press send, and the draft is marked used at that point rather than deleted,
-- so a call that comes in just after can still be traced.
--
-- Anonymous until it is not. Prices are public on that page and a candidate can
-- fill in most of the form before signing in, so client_id is nullable and is
-- filled in when they do.
--
-- The code is the whole access control: 8 unambiguous characters, no vowels, so
-- it survives being read down a phone line and cannot spell anything. It is
-- unguessable enough for a basket of sign quantities, which is what it holds.

CREATE TABLE IF NOT EXISTS election_drafts (
  code        TEXT PRIMARY KEY,
  client_id   INT REFERENCES clients(id) ON DELETE SET NULL,

  -- The basket exactly as the form holds it: signs, print, decals, artwork.
  -- Deliberately opaque — the price list is code, and a draft is only ever
  -- re-priced by it, never trusted for money.
  basket      JSONB NOT NULL DEFAULT '{}'::jsonb,

  -- Who it is for, so staff can tell two callers apart before either signs in.
  candidate_name TEXT,
  office         TEXT,
  municipality   TEXT,
  ward           TEXT,
  contact_name   TEXT,
  contact_phone  TEXT,
  contact_email  TEXT,
  notes          TEXT,

  -- Set when the draft became a job, with the job it became.
  submitted_project_id INT REFERENCES projects(id) ON DELETE SET NULL,

  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Staff look these up by the caller's name as often as by the code, because a
-- candidate who has lost the code still knows their own name.
CREATE INDEX IF NOT EXISTS election_drafts_candidate_idx
  ON election_drafts (LOWER(candidate_name));

CREATE INDEX IF NOT EXISTS election_drafts_updated_idx
  ON election_drafts (updated_at DESC);

CREATE INDEX IF NOT EXISTS election_drafts_client_idx
  ON election_drafts (client_id);
