-- 069_reader_events.sql
-- Counter POS card-reader diary.
--
-- The WisePad keeps dropping and every round of diagnosing it so far has been
-- somebody looking at the tablet AFTER the fact and guessing from a snapshot:
-- no record of when it dropped, what the SDK said the reason was, whether the
-- watchdog tried, or whether the tablet got it back on its own. Three separate
-- causes have been found and fixed that way, at roughly a morning each, and
-- the problem is still here.
--
-- So: the tablet writes down what happens. One row per event, posted
-- fire-and-forget. This table is diagnostics, NOT money — it is deliberately
-- separate from terminal_payments, nothing reconciles against it, and it can
-- be truncated at any time without consequence.
--
-- Safe to re-run.

CREATE TABLE IF NOT EXISTS reader_events (
  id             BIGSERIAL   PRIMARY KEY,

  -- What happened. Free text rather than an enum: this is a diagnostic log
  -- and a migration to add a value would be a silly reason not to record
  -- something new. Values the tablet currently sends:
  --   connected, disconnected, unexpected_disconnect,
  --   watchdog_reconnecting, watchdog_recovered, watchdog_failed,
  --   hidden, visible, printed, payment_started, payment_finished
  event          TEXT        NOT NULL,

  -- The SDK's own disconnect reason where it gives one, or our error text.
  reason         TEXT,

  reader_serial  TEXT,
  -- 0-100. Worth having: a reader that drops as the battery falls is a
  -- different fault from one that drops at random, and the counter reader is
  -- supposed to be on USB power permanently.
  battery_pct    INT,

  -- Whatever else the tablet thought was worth attaching — app visibility,
  -- how long since the last successful print, the connection status the
  -- store believed it was in. Free-form so adding a field needs no migration.
  detail         JSONB,

  -- When the TABLET says it happened. The tablet can be offline when an
  -- event occurs and flush it later, so this is not the same as created_at
  -- and it is the one to order by when reading the story back.
  occurred_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS reader_events_occurred_idx
  ON reader_events (occurred_at DESC);
