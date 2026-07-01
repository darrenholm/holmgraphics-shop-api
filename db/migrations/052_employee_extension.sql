-- 052_employee_extension.sql
-- employees.phone_extension — the staff member's SkySwitch PBX extension
-- (e.g. 104, 108). Separate from phone_number (their mobile, added in
-- 051_sms_notifications.sql): the extension is their desk/softphone line on
-- the VoIP system, the cell is where job-assignment texts go.
--
-- Not wired to anything yet — captured here so the staff-contact admin screen
-- can hold it and future telephony features (click-to-dial, internal
-- directory, call routing) have it on hand. Nullable; blank is fine.
--
-- Safe to re-run.
ALTER TABLE employees
  ADD COLUMN IF NOT EXISTS phone_extension TEXT;
