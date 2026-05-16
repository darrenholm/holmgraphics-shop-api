# QBO Employee Matching Feature

## Overview

This feature allows you to match local employees to QuickBooks Online employees, enabling timesheet sync without manual configuration. The matching engine uses fuzzy name matching, email validation, and confidence scoring to suggest matches, with a UI for admins to review and confirm.

## Architecture

### Database Schema

**New Table: `employee_match_candidates`** (migration 019)
- Stores matcher results: local employee → QBO employee candidates
- Tracks user review and confirmation
- One confirmed match per local employee
- Audit trail with timestamps

**Updated Tables:**
- `employees.qbo_employee_id` — TEXT column linking to QBO (already in migration 018)
- `time_entries.qbo_time_activity_id` — stores synced QBO ID (already in migration 018)

### Backend Components

#### 1. **Matcher Engine** (`lib/qbo-employee-matcher.js`)
Fuzzy matching algorithm with confidence scoring:
- **95%** — Exact full name match
- **92%** — Exact first + last name match
- **82-85%** — Fuzzy full name similarity
- **70%** — Partial fuzzy match
- **+5% boost** — Email domain match (e.g., both @acme.com)

Uses Levenshtein distance for fuzzy matching with configurable thresholds.

**Main function:** `matchEmployees(localEmployees)`
Returns: auto-matches (≥85% confidence) + review candidates (50-84%) + unmapped

#### 2. **API Endpoints** (`routes/qbo-employee-match.js`)

**POST /api/qbo-match/match-employees** (Admin)
- Runs matcher against unmapped employees
- Auto-links high-confidence matches
- Stores candidates in DB for review
- Returns summary: auto_matches, review_matches, unmapped

**GET /api/qbo-match/pending-matches** (Admin)
- Fetches all unreviewed match candidates
- Grouped by local employee
- Shows top-N candidates per person

**POST /api/qbo-match/confirm-match** (Admin)
- Body: `{ local_employee_id, qbo_employee_id }`
- Links employee and marks candidate confirmed
- Cleans up other candidates for that employee

#### 3. **Sync Endpoint Change** (`routes/quickbooks.js`)
`POST /api/quickbooks/sync-time-period/:id` now:
- **Rejects** the entire sync if ANY timesheet has an unmapped employee
- Returns clear error with list of unmapped employees
- Directs user to the matching page

This prevents silent skips and partial syncs.

### Frontend

**HTML Page:** `lib/qbo-match-employees.html`
- Self-contained, static file (can be served from any HTTP server)
- Four-section UI:
  1. **Run Matcher** — triggers backend analysis
  2. **Auto-Matched** — high-confidence matches (read-only, already linked)
  3. **Needs Review** — lower-confidence matches, admin picks one per person
  4. **No Candidates** — employees with zero matches, needs manual QB creation

Real-time alerts and status bar showing counts.

## Deployment

### 1. Run Migration
```bash
npm run migrate
# This will create the employee_match_candidates table
```

### 2. Deploy Code
```bash
git push
# Railway auto-deploys to holmgraphics-api
```

### 3. Host the UI
The HTML page needs to be served somewhere accessible to admins. Options:

**Option A: Serve from Express (Recommended)**
Add to `server.js` after other routes:
```javascript
// Serve the QBO match UI as a static file
app.get('/admin-legacy/qbo-match-employees.html', (req, res) => {
  res.sendFile(path.join(__dirname, 'lib/qbo-match-employees.html'));
});
```

**Option B: Copy to SvelteKit shop app**
Copy `lib/qbo-match-employees.html` to `holmgraphics-shop/static/admin-legacy/qbo-match-employees.html`
- User visits: `https://shop.holmgraphics.ca/admin-legacy/qbo-match-employees.html`

**Option C: Host in existing admin folder**
If using WHC (shared hosting), upload the file to `public_html/admin-legacy/`

## Usage Workflow

### For Admins

1. **First Time Setup:**
   - Navigate to the matching page: `/admin-legacy/qbo-match-employees.html`
   - Click **"Run Matcher"**
   - Review results (auto-matches are already linked)

2. **Resolving Ambiguous Matches:**
   - In "Needs Review" section, select the correct QB employee for each person
   - Click **"Select"** to confirm
   - Confirmed matches are removed from the pending list

3. **Unmapped Employees:**
   - If no QB candidates exist, you must create the employee in QuickBooks first
   - Then re-run the matcher
   - Or manually create the link in the DB (see Admin Operations below)

4. **After Matching:**
   - All employees should now have `qbo_employee_id` set
   - Can proceed with timesheet sync: go to pay period, click "Send to QuickBooks"

### For Developers

**Testing the matcher locally:**
```javascript
const { matchEmployees } = require('./lib/qbo-employee-matcher');

const localEmployees = [
  { id: 1, first_name: 'John', last_name: 'Smith', email: 'jsmith@acme.com' },
  { id: 2, first_name: 'Jane', last_name: 'Doe', email: 'jdoe@acme.com' },
];

const results = await matchEmployees(localEmployees);
console.log(results.auto_matches);    // High confidence
console.log(results.review_matches);  // Needs human review
console.log(results.unmapped);        // No candidates
```

## Admin Operations

### Manual Link (Bypass Matcher)
If you trust a match without running the full UI:
```sql
UPDATE employees
   SET qbo_employee_id = 'QB_EMPLOYEE_ID_HERE'
 WHERE id = LOCAL_EMPLOYEE_ID;
```

### Unlink an Employee
```sql
UPDATE employees
   SET qbo_employee_id = NULL
 WHERE id = LOCAL_EMPLOYEE_ID;
```

### Delete Matcher Candidates (Fresh Run)
```sql
DELETE FROM employee_match_candidates
 WHERE local_employee_id = LOCAL_EMPLOYEE_ID;
```

### View Current Mappings
```sql
SELECT
  e.id,
  CONCAT(e.first_name, ' ', e.last_name) AS local_name,
  e.qbo_employee_id,
  e.email
FROM employees e
ORDER BY e.first_name, e.last_name;
```

## Troubleshooting

### "No candidates found" for an employee
- Employee doesn't exist in QB, OR
- Their name is spelled very differently in QB
- **Fix:** Create/rename in QB, then re-run matcher

### Sync still failing: "unmapped employees detected"
- The endpoint rejects ANY unmapped employees
- Run the matcher and confirm all matches first
- `SELECT * FROM employees WHERE qbo_employee_id IS NULL;`

### Matcher running slowly
- First-time fetch of 200+ QB employees takes a few seconds
- Normal, not a bug
- Subsequent runs are faster (candidates cached in DB)

### Confidence scores seem low
- Name spelling differences accumulate with Levenshtein distance
- "John Smith" vs "Jon Smyth" → ~75% match
- Email match gives +5% boost
- First name-only match → 60% fallback
- If confident despite score, just click "Select"

## Configuration

### Confidence Thresholds (Tunable in `lib/qbo-employee-matcher.js`)

Edit these constants to adjust behavior:
```javascript
// Lines 39-42
EXACT_FULL_NAME_CONFIDENCE = 0.95;
EXACT_FIRST_LAST = 0.92;
FUZZY_HIGH = 0.82;      // sim >= 0.80
FUZZY_MEDIUM = 0.70;    // sim >= 0.65

// Filter line 159
.filter(c => c.confidence >= 0.50)  // Only show 50%+ confidence

// Auto-link threshold line 167
&& candidates[0].confidence >= 0.85  // Auto-link only 85%+
```

Increase thresholds for stricter matching (fewer auto-links), or decrease for more aggressive auto-matching.

## Files Added/Modified

### New Files
- `lib/qbo-employee-matcher.js` — Core fuzzy matching logic
- `lib/qbo-match-employees.html` — Admin UI
- `routes/qbo-employee-match.js` — API endpoints
- `db/migrations/019_employee_match_candidates.sql` — Schema

### Modified Files
- `routes/quickbooks.js` — Updated `/sync-time-period/:id` to reject unmapped
- `server.js` — Added import + route mount for qbo-match

## Testing Checklist

- [ ] Migration runs without errors
- [ ] Can access `/admin-legacy/qbo-match-employees.html`
- [ ] "Run Matcher" button works, fetches QBO employees
- [ ] Auto-matches appear in "Auto-Matched" section
- [ ] Can click "Select" on a candidate, match confirms
- [ ] Confirmed matches disappear from "Needs Review"
- [ ] Unmapped employees show in "No Candidates" section
- [ ] QBO sync endpoint rejects if unmapped employees exist
- [ ] After all matches confirmed, sync succeeds

## Future Enhancements

1. **Manual Entry:** Allow admins to type in QBO employee name if no candidates
2. **Batch Confirm:** Bulk-confirm all >90% confidence matches at once
3. **History:** Track who linked which employee, when
4. **Auto-Refresh:** Re-run matcher periodically to catch new QBO employees
5. **Email Sync:** If email is sole match, auto-confirm without manual click
6. **Invite New:** If no QB employee exists, offer to create one via API

## Support

For issues or questions, check:
- `routes/qbo-employee-match.js` — endpoint logic
- `lib/qbo-employee-matcher.js` — matching algorithm
- Browser console (F12) — client-side errors on the UI page
