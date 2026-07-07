-- 055_employee_must_change_password.sql
-- Force-password-change flag for staff logins. Set TRUE when an admin
-- assigns a temporary password (POST /auth/set-password); cleared when the
-- employee changes it themselves (POST /auth/change-password). The shop
-- redirects flagged users to /profile until they change it.
--
-- Safe to re-run.

ALTER TABLE employees
  ADD COLUMN IF NOT EXISTS must_change_password BOOLEAN NOT NULL DEFAULT FALSE;
