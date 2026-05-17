# QBO Payroll Direct Sync Implementation

## Overview
Implemented direct QuickBooks Online (QBO) Payroll integration that allows syncing time entries directly to QBO Payroll without requiring manual CSV export or intermediate steps.

## What Was Built

### 1. Database Schema (Migration 020)
**File:** `db/migrations/020_qbo_payroll_sync.sql`

Created new table to track payroll syncs:
- `qbo_payroll_syncs` table with columns:
  - `id` - Primary key
  - `pay_period_id` - Links to pay period being synced
  - `synced_at` - When the sync occurred
  - `synced_by` - Employee ID of who initiated sync
  - `entry_count` - How many time entries were synced
  - `qbo_sync_token` - Response token from QBO (if available)
  - `status` - 'pending', 'success', or 'failed'
  - `error_message` - If status='failed'
  - `created_at`, `updated_at` - Audit timestamps

Added column to time_entries:
- `qbo_synced_at` - Timestamp when entry was synced to payroll

Added indexes for efficient lookups and triggers for auto-updating timestamps.

### 2. API Endpoint
**File:** `routes/quickbooks.js` - Added `POST /api/quickbooks/sync-payroll/:id`

#### Endpoint Details
- **Route:** `POST /api/quickbooks/sync-payroll/:id`
- **Parameter:** `id` = pay_period_id to sync
- **Auth:** Requires admin access via `requireAdmin` middleware
- **Returns:** JSON response with sync results

#### Workflow
1. Validates pay period exists
2. Fetches all closed/approved time entries for the period
3. Filters out entries already synced to payroll (qbo_synced_at IS NOT NULL)
4. Computes lunch deductions per shop policy (> 4h/day = -30 min deduction)
5. Groups entries by employee and sums PAID hours for the entire period
6. For each employee with hours:
   - Creates TimeActivity record in QBO with aggregated hours
   - Marks time_entries as synced (qbo_synced_at = NOW())
7. Records sync attempt in qbo_payroll_syncs table
8. Returns summary of synced employees, entries, and any errors

#### Response Format
```json
{
  "pay_period_id": 5,
  "synced_employees": 4,
  "synced_entries": 25,
  "total_hours": 168.5,
  "skipped_no_mapping": 0,
  "skipped_already_synced": 2,
  "errors": [
    {
      "employee_name": "John Doe",
      "employee_id": 12,
      "message": "Failed to create TimeActivity in QBO"
    }
  ]
}
```

#### Key Features
- **Idempotent:** Re-running the same period skips already-synced entries
- **Lunch Deduction:** Automatically applies per-shop policy (>4h/day = -30 min)
- **Lunch Distribution:** If longest entry < 30 min, cascades deduction to next-longest
- **Partial Success:** If some employees fail to sync, others still complete
- **Audit Trail:** Records who initiated sync, when, how many entries
- **Employee Mapping:** Requires employees.qbo_employee_id to be set (via QBO employee matcher)

### 3. Integration Points

#### Time Entry Workflow
Synced entries track the complete lifecycle:
```
time_entries.status: closed → approved → exported (to CSV export)
time_entries.qbo_synced_at: NULL → NOW() (to QBO Payroll)
```

Both can happen independently:
- An entry can be exported to CSV without being synced to QBO Payroll
- An entry can be synced to QBO Payroll without being exported to CSV

#### Dependencies
- Requires employee mapping via `POST /api/qbo-match/suggest` endpoint
- Uses existing lunch deduction logic from `routes/time.js`
- Uses existing QBO authentication tokens from `lib/qbo-tokens.js`
- Uses existing QBO HTTP helpers from `lib/qbo-sync.js`

## Usage

### Step 1: Close Pay Period
```bash
POST /api/pay-periods/admin/:id/close
```

### Step 2: Approve/Review Time Entries
Staff can approve entries via:
```bash
POST /api/time/admin/:id/approve
POST /api/time/admin/bulk-approve
```

### Step 3: Sync to QBO Payroll
```bash
POST /api/quickbooks/sync-payroll/:pay_period_id
```

Optional: Export to CSV for backup:
```bash
GET /api/time/admin/export?pay_period_id=:id
```

## Database Schema Details

### qbo_payroll_syncs table
```sql
CREATE TABLE qbo_payroll_syncs (
  id              SERIAL PRIMARY KEY,
  pay_period_id   INTEGER NOT NULL REFERENCES pay_periods(id),
  synced_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  synced_by       INTEGER NOT NULL REFERENCES employees(id),
  entry_count     INTEGER NOT NULL,
  qbo_sync_token  TEXT,
  status          VARCHAR(20) DEFAULT 'pending',
  error_message   TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_qbo_payroll_syncs_pay_period
  ON qbo_payroll_syncs (pay_period_id);

-- Auto-update timestamp on changes
CREATE TRIGGER qbo_payroll_syncs_updated_at_trigger
  BEFORE UPDATE ON qbo_payroll_syncs
  FOR EACH ROW
  EXECUTE FUNCTION qbo_payroll_syncs_set_updated_at();
```

### time_entries additions
```sql
ALTER TABLE time_entries 
ADD COLUMN qbo_synced_at TIMESTAMPTZ;

CREATE INDEX idx_time_entries_qbo_synced
  ON time_entries (qbo_synced_at);
```

## Implementation Notes

### QBO API Integration
- Uses `/timeactivity` endpoint with `minorversion=65`
- Aggregates employee hours for the entire pay period
- Creates one TimeActivity record per employee per period
- TimeActivity records are flagged as `NotBillable` for payroll
- Honors QBO authentication token management (auto-refresh within 60s of expiry)

### Lunch Deduction Logic
Consistent with existing time tracking module:
- Threshold: 4 hours (240 minutes) per calendar day
- Deduction: 30 minutes unpaid lunch
- Applied to longest entry first, cascading if needed
- Calendar day uses shop timezone (America/Toronto)
- Only applied to closed entries with clock_out timestamp

### Error Handling
- Pre-checks for unmapped employees (prevents partial syncs)
- Per-employee error isolation (one employee's failure doesn't block others)
- Detailed error messages from QBO for debugging
- Errors recorded in qbo_payroll_syncs.error_message
- Maintains sync audit trail even on failure

### Idempotency
- Safe to re-run same period multiple times
- Skips entries where qbo_synced_at IS NOT NULL
- Skips zero-minute entries (after lunch deduction)
- Each entry's sync status tracked independently

## Testing Checklist

- [ ] Verify migration runs on Railway deploy
- [ ] Test sync with single employee, multiple entries
- [ ] Test lunch deduction calculation
- [ ] Test re-running same period (idempotency)
- [ ] Verify qbo_synced_at timestamp is set
- [ ] Check qbo_payroll_syncs table has audit record
- [ ] Test with unmapped employee (should skip with message)
- [ ] Verify TimeActivity records appear in QBO
- [ ] Test error handling if QBO API fails
- [ ] Verify hours match: (clock_out - clock_in - lunch_deduction) / 60 = hours

## Future Enhancements

1. **Batch Hours Endpoint** - If QBO Payroll has dedicated batch hours endpoint, use that instead of TimeActivity
2. **Payroll Period Mapping** - Map QB Payroll periods to local pay_periods for automatic matching
3. **Webhooks** - Listen for QBO updates to sync back status
4. **Reconciliation Report** - Compare synced hours vs QB Payroll to catch discrepancies
5. **Rate Codes** - Map entries to different pay rate codes (regular, OT, etc.)
6. **Job Costing** - Allocate hours to QB Customer for job costing
7. **Performance Tracking** - Log sync metrics (time, success rate) for monitoring

## Related Files

- `db/migrations/020_qbo_payroll_sync.sql` - Database schema
- `routes/quickbooks.js` - API endpoint (POST /api/quickbooks/sync-payroll/:id)
- `routes/time.js` - Lunch deduction logic
- `lib/qbo-sync.js` - QBO HTTP helpers
- `lib/qbo-tokens.js` - OAuth token management
