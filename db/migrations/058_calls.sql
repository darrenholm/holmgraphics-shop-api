-- 058_calls.sql
-- Telephony event log. Every Action URL request the Grandstream handsets fire
-- lands here — matched or not, known caller or not.
--
-- NO PHONE-SUPPLIED CALL ID EXISTS ON THIS HARDWARE. The GXP16xx/21xx Action
-- URL variable set is $remote / $active_user only; $call_id and $callid are
-- passed through as literal text. So ringing → answered → ended cannot be
-- joined by a device key. Correlation is done server-side on
-- (remote_e164, created_at within CORRELATION_WINDOW_MS) — see
-- lib/call-correlate.js. Do not add a phone_call_id column expecting the
-- devices to start sending one; they won't.
--
-- A ring group rings N handsets and each fires its own Incoming Call event,
-- so ONE inbound call legitimately produces N 'ringing' rows with the same
-- remote_e164 and different local_ext. That's intentional: the set of
-- local_ext values is the list of desks that rang. The de-duplication to a
-- single screen pop happens at the broadcast layer, not here.

CREATE TABLE IF NOT EXISTS calls (
  id            SERIAL      PRIMARY KEY,
  event         TEXT        NOT NULL
                            CHECK (event IN ('ringing', 'answered', 'ended')),
  direction     TEXT        NOT NULL DEFAULT 'inbound'
                            CHECK (direction IN ('inbound', 'outbound')),
  remote_raw    TEXT,                   -- exactly as the phone sent it
  remote_e164   TEXT,                   -- NULL when unparseable / blocked
  local_ext     TEXT,                   -- $active_user — the desk that rang
  device_mac    TEXT,                   -- reserved; $mac isn't wired up yet
  client_id     INT         REFERENCES clients(id) ON DELETE SET NULL,
  started_at    TIMESTAMPTZ,
  ended_at      TIMESTAMPTZ,
  duration_s    INTEGER,
  handled_by    TEXT,                   -- employee name, resolved from local_ext
  note          TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS calls_remote_e164_idx ON calls (remote_e164);
CREATE INDEX IF NOT EXISTS calls_created_at_idx  ON calls (created_at DESC);
CREATE INDEX IF NOT EXISTS calls_client_idx      ON calls (client_id, created_at DESC);

-- Correlation lookup: "the most recent ringing row for this number".
-- Partial so it stays small — 'ringing' is the only event we correlate FROM.
CREATE INDEX IF NOT EXISTS calls_ringing_corr_idx
  ON calls (remote_e164, created_at DESC)
  WHERE event = 'ringing';
