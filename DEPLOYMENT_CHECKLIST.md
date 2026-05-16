# QBO Employee Matching — Deployment Checklist

## Pre-Deployment

- [ ] All code committed to repo
- [ ] Database backups taken (safety first!)
- [ ] `.env` file has `QB_CLIENT_ID`, `QB_CLIENT_SECRET`, `QB_REDIRECT_URI` (already in place?)

## Deployment Steps

### Step 1: Push Code to GitHub
```bash
git add .
git commit -m "feat: Add QBO employee matching with fuzzy name matching and admin UI"
git push origin main
```

### Step 2: Railway Auto-Deploy
- Code automatically deploys to Railway once pushed
- Check Railway dashboard: https://railway.app
- Build should complete in ~2 minutes

### Step 3: Verify Deployment
Once deployed to Railway:
```bash
# Test health endpoint
curl https://your-api.up.railway.app/api/health

# Should return:
# { "status": "ok", "service": "holmgraphics-api", ... }
```

### Step 4: Run Migrations
Railway auto-runs migrations on startup via `runMigrations()` in `server.js`, so the `employee_match_candidates` table should already exist.

To verify manually:
```bash
# Connect to Railway Postgres
psql $DATABASE_URL -c "SELECT * FROM employee_match_candidates LIMIT 1;"

# Should succeed (table exists) or show empty result
```

### Step 5: Access the UI
Navigate to:
```
https://your-api.up.railway.app/admin-legacy/qbo-match-employees.html
```

Should see the QBO Employee Matching page with "Run Matcher" button.

---

## Testing Checklist

### Basic Functionality

- [ ] **Page loads** — Navigate to `/admin-legacy/qbo-match-employees.html`
  - Should see header + "Run Matcher" button
  - No JavaScript errors in console (F12)

- [ ] **Matcher runs** — Click "Run Matcher"
  - Button disables + shows spinner
  - Check browser Network tab: `POST /api/qbo-match/match-employees` should return 200
  - Spinner disappears, results display

- [ ] **Results display** — After matcher completes:
  - Status bar shows counts (auto_matches, review_matches, unmapped)
  - At least one section should be visible

### Auto-Matched Employees

- [ ] **Auto-matches section** — If count > 0:
  - Shows employee names + QBO names
  - Displays confidence scores (should be ≥85%)
  - Read-only (no buttons)

### Manual Review

- [ ] **Review section** — If count > 0:
  - Shows local employee names + email
  - Lists 2-5 QBO candidates per employee
  - Each candidate has confidence badge + "Select" button
  - Clicking "Select" calls `/api/qbo-match/confirm-match`

- [ ] **After confirming a match**:
  - Success alert appears
  - Employee disappears from review list
  - Check DB: `SELECT qbo_employee_id FROM employees WHERE id = ?;` should be set

### Unmapped Employees

- [ ] **No Candidates section** — If count > 0:
  - Shows employee names
  - Lists reason: "No matching QuickBooks employees found"
  - Includes instructions to create in QB

### Sync Integration

- [ ] **Before mapping**: Try syncing a pay period
  - Should fail with 409 error
  - Error message: "unmapped employees detected"
  - Lists which employees are unmapped

- [ ] **After mapping**: Sync should work
  - Button click works
  - Time entries POST to QBO
  - Check QB: TimeActivity records appear

---

## Database Verification

### Check Table Creation
```sql
-- Should show the new table
SELECT table_name 
  FROM information_schema.tables 
 WHERE table_schema = 'public' 
   AND table_name = 'employee_match_candidates';
```

### Check Stored Matches
```sql
-- View any stored match candidates
SELECT 
  emc.local_employee_id,
  CONCAT(e.first_name, ' ', e.last_name) AS local_name,
  emc.qbo_employee_id,
  emc.match_confidence,
  emc.user_confirmed,
  emc.created_at
FROM employee_match_candidates emc
JOIN employees e ON e.id = emc.local_employee_id
ORDER BY emc.created_at DESC;
```

### Check Linked Employees
```sql
-- See which employees have QBO mappings
SELECT 
  id,
  CONCAT(first_name, ' ', last_name) AS name,
  email,
  qbo_employee_id,
  CASE WHEN qbo_employee_id IS NULL THEN 'UNMAPPED' ELSE 'MAPPED' END AS status
FROM employees
ORDER BY first_name, last_name;
```

---

## Troubleshooting

### "Page shows blank"
- **Check:** F12 console for errors
- **Fix:** API URL might be wrong if deployed to different domain
  - Open `qbo-match-employees.html`
  - Look for `const API_BASE = ...` line
  - Adjust if needed (should auto-detect from window.location)

### "Run Matcher button does nothing"
- **Check:** Browser console (F12) for errors
- **Check:** Network tab → POST `/api/qbo-match/match-employees` — what's the response?
- **Likely:** QBO tokens not connected
  - Visit `/api/quickbooks/status` to check connection
  - If not connected, click the QB "Connect" button first

### "Matcher returns 0 results"
- **Check:** How many local employees are unmapped?
  ```sql
  SELECT COUNT(*) FROM employees WHERE qbo_employee_id IS NULL;
  ```
- **Check:** How many QBO employees exist?
  - Click "Run Matcher" and check the response JSON
  - Should show `total_qbo_employees: > 0`
- **If 0 QBO employees:** Create some in QB first

### "Sync still fails after mapping"
- **Check:** Did `employees.qbo_employee_id` actually get set?
  ```sql
  SELECT id, first_name, last_name, qbo_employee_id 
    FROM employees 
   WHERE qbo_employee_id IS NULL;
  ```
- **If still NULL:** Run matcher again and confirm matches

### "Confidence scores all look low"
- This is normal if names differ significantly
- Click "Select" if you're confident it's the right person
- Fuzzy matching errs on the side of caution

---

## Rollback Plan

If something goes wrong:

### Undo Changes (Keep Timesheets Intact)
```sql
-- Clear all QBO mappings (revert to pre-match state)
UPDATE employees SET qbo_employee_id = NULL;

-- Delete matcher candidates (clean slate for retry)
DELETE FROM employee_match_candidates;
```

### Full Rollback
```bash
git revert HEAD  # or git reset to previous commit
git push origin main
# Railway auto-redeploys to previous version
```

---

## Performance Notes

- **First matcher run:** ~2–3 seconds (fetches 200 QBO employees)
- **Subsequent runs:** Faster (candidates cached in DB)
- **UI is responsive:** No page slowdown even with 50+ employees

---

## Files Changed Summary

**New:**
- `lib/qbo-employee-matcher.js` — Matching engine
- `lib/qbo-match-employees.html` — Admin UI
- `routes/qbo-employee-match.js` — API endpoints
- `db/migrations/019_employee_match_candidates.sql` — Schema
- `lib/QBO_EMPLOYEE_MATCHING.md` — Full documentation

**Modified:**
- `routes/quickbooks.js` — Sync endpoint now rejects unmapped
- `server.js` — Mount qbo-match routes + serve HTML
- `DEPLOYMENT_CHECKLIST.md` — This file

---

## Post-Deployment

### Train Admins
1. Show them the matching page
2. Run through a complete matcher → confirm → sync flow
3. Explain: high-confidence auto-links, manual review for ambiguous matches

### Monitor
- Check Railway logs for any errors
- Watch for admin feedback on matching accuracy
- If many employees are unmapped, you may need to:
  - Create them in QB
  - Adjust confidence thresholds in the matcher

### Next Steps (Optional Enhancements)
1. Batch confirm all >90% matches with one click
2. Add email-only matching (if no name match)
3. Store matcher run history for audit trail
4. Auto-refresh matcher on schedule (weekly)

---

## Questions?

- **API Issues:** Check `routes/qbo-employee-match.js` + Railway logs
- **UI Issues:** Check browser console (F12) + Network tab
- **Matching Accuracy:** See `lib/qbo-employee-matcher.js` scoring logic
- **Schema Issues:** See `db/migrations/019_employee_match_candidates.sql`

Good luck! 🚀
