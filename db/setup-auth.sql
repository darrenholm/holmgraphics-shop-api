-- setup-auth.sql
-- Run this ONCE in Azure Portal Query Editor (or SSMS)
-- Adds web-login support to your existing Employee table
-- ─────────────────────────────────────────────────────────────────────────────

-- 1. Add PasswordHash column (stores bcrypt hash, never plaintext)
IF NOT EXISTS (
  SELECT 1 FROM sys.columns
  WHERE object_id = OBJECT_ID('Employee') AND name = 'PasswordHash'
)
BEGIN
  ALTER TABLE Employee ADD PasswordHash NVARCHAR(255) NULL;
  PRINT '✅ Added PasswordHash column';
END
ELSE
  PRINT '⚠️  PasswordHash already exists — skipped';

-- 2. Add Role column  ('admin' | 'staff' | 'client')
IF NOT EXISTS (
  SELECT 1 FROM sys.columns
  WHERE object_id = OBJECT_ID('Employee') AND name = 'Role'
)
BEGIN
  ALTER TABLE Employee ADD Role NVARCHAR(50) NULL DEFAULT 'staff';
  PRINT '✅ Added Role column';
END
ELSE
  PRINT '⚠️  Role already exists — skipped';

-- 3. Add Active column
IF NOT EXISTS (
  SELECT 1 FROM sys.columns
  WHERE object_id = OBJECT_ID('Employee') AND name = 'Active'
)
BEGIN
  ALTER TABLE Employee ADD Active BIT NOT NULL DEFAULT 1;
  PRINT '✅ Added Active column';
END
ELSE
  PRINT '⚠️  Active already exists — skipped';

-- 4. Set Darren as admin (update email to match)
UPDATE Employee
SET Role = 'admin'
WHERE Email = 'darren@holmgraphics.ca';
PRINT '✅ Set admin role for darren@holmgraphics.ca';

-- ─────────────────────────────────────────────────────────────────────────────
-- After running this SQL, set passwords via the API:
--
--   POST http://localhost:3000/api/auth/set-password
--   Body: { "employeeId": 1, "password": "YourPassword" }
--
-- Or use the quick setup script:
--   node db/set-passwords.js
-- ─────────────────────────────────────────────────────────────────────────────

-- Show current employee list
SELECT EmployeeID, FirstName, LastName, Email, Role, Active,
       CASE WHEN PasswordHash IS NOT NULL THEN 'SET' ELSE 'NOT SET' END AS PasswordStatus
FROM Employee
ORDER BY EmployeeID;
