-- Trust flag for the LED-ad self-serve portal.
--
-- When TRUE (the default): a logged-in advertiser can swap their on-screen
-- ad without admin re-review — the upload runs through the artwork validator,
-- the rental stays in 'active' state, and the LED app immediately republishes
-- the new asset to VNNOX.
--
-- When FALSE: a swap moves the rental back to 'pending_review' and clears
-- the running program from VNNOX so admin sees + approves the new art before
-- it appears on the screen.
--
-- Default TRUE because these advertisers are existing Holm Graphics clients
-- with a long-standing relationship; the toggle is the kill-switch admins
-- can flip for any client whose ads cause trouble.

ALTER TABLE clients
  ADD COLUMN IF NOT EXISTS trust_self_serve_ads BOOLEAN NOT NULL DEFAULT TRUE;
