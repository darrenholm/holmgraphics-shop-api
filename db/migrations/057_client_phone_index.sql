-- 057_client_phone_index.sql
-- Normalized E.164 lookup surface for inbound caller-ID matching (screen pop).
--
-- WHY A NEW TABLE INSTEAD OF A COLUMN ON client_phones:
-- Client numbers live in TWO places and neither is normalized:
--   • client_phones.number  — the staff-entered contact list (main/mobile/fax…)
--   • clients.phone         — the single number captured by the DTF-store
--                             self-serve signup (migration 008)
-- and both carry every punctuation convention we've ever used
-- (519-881-1234, (519) 881 1234, 5198811234, "…ext 2"). An inbound call
-- arrives as a bare 11-digit string (15198891343), so matching needs ONE
-- indexed surface holding the E.164 form of every number from every source.
--
-- This table is DERIVED, never hand-edited. It is rebuilt per-client by
-- lib/phone-index.js on every write path that touches a phone number, and
-- backfilled once by scripts/backfill-client-phones.js.
--
-- NOTE ON NAMING: the Phase 1 spec calls this `customer_phones` referencing
-- `customers(id)`. This schema has no `customers` table — the entity is
-- `clients` with an INTEGER id — and `client_phones` is already taken by the
-- source table above. Renamed to match the codebase's own vocabulary.

CREATE TABLE IF NOT EXISTS client_phone_index (
  id            SERIAL      PRIMARY KEY,
  client_id     INT         NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  e164          TEXT        NOT NULL,
  label         TEXT,                   -- 'main' | 'mobile' | 'shop' | …
  -- Which column the number was derived from, e.g. 'client_phones.number#42'
  -- or 'clients.phone'. Kept so a bad match can be traced back to the row that
  -- produced it without guessing.
  source_field  TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS client_phone_index_e164_idx
  ON client_phone_index (e164);

-- One row per (client, number). Two contacts at the same company sharing a
-- shop line collapse to a single index row — that's correct, the pop matches
-- the client, not the contact.
CREATE UNIQUE INDEX IF NOT EXISTS client_phone_index_unique_idx
  ON client_phone_index (client_id, e164);
