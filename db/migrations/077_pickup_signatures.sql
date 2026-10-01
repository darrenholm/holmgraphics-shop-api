-- 077_pickup_signatures.sql
-- Client signatures at pickup, taken on the counter's WisePOS E.
--
-- Staff press "Pickup signature" on a job; the reader asks the client for
-- their name and a finger signature (Stripe Terminal collect_inputs, no
-- payment involved). The SVG comes back as a Stripe file that Stripe deletes
-- after 7 days, so the SVG itself is copied in here — this table is the
-- shop's only lasting copy.
--
-- One row per request, not per job: a job picked up in two loads gets two
-- signatures, and a request the client walked away from stays as 'failed'
-- or 'cancelled' rather than vanishing.
--
-- Safe to re-run.

CREATE TABLE IF NOT EXISTS pickup_signatures (
  id               SERIAL PRIMARY KEY,
  project_id       INTEGER NOT NULL,
  reader_id        TEXT NOT NULL,
  status           TEXT NOT NULL DEFAULT 'pending',
  signer_name      TEXT,
  signature_svg    TEXT,
  stripe_file_id   TEXT,
  failure_message  TEXT,
  requested_by_emp_id INTEGER,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  signed_at        TIMESTAMPTZ,
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

DO $$ BEGIN
  ALTER TABLE pickup_signatures
    ADD CONSTRAINT pickup_signatures_status_check
    CHECK (status IN ('pending', 'signed', 'failed', 'cancelled'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE INDEX IF NOT EXISTS pickup_signatures_project_idx
  ON pickup_signatures (project_id, created_at DESC);
