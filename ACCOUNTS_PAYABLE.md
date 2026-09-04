# Accounts Payable — supplier invoices and statements

Replaces forwarding bills to `holmgraphics@qbodocs.com`. That address feeds
QuickBooks' **Receipts** tray, which captures vendor/date/total only, loses
line items and terms, and has no concept of a supplier statement.

The flow:

```
supplier PDF ──▶ ap_documents ──▶ Claude extraction ──▶ review queue
                                                            │
                                          approve ──────────┤
                                                            ▼
                                          QBO Bill + PDF attachment
                                                            │
                       month-end statement ──▶ reconcile ───┘
```

The reconcile step is the part QuickBooks cannot do at all: it diffs the
supplier's month-end statement against what we actually booked and reports
what is **missing** — billed by the supplier, never entered by us.

## Files

| Path | Role |
|---|---|
| `db/migrations/064_ap_bills.sql` | Schema. Money in integer cents throughout. |
| `lib/ap-extract.js` | PDF → structured data via the Claude API. Owns the money/date/vendor parsers. |
| `lib/ap-intake.js` | Hash, dedupe, store, then run extraction and resolve the vendor. |
| `lib/ap-qbo-bills.js` | Vendor/account/term lookup, duplicate detection, Bill creation, PDF attach. |
| `lib/ap-reconcile.js` | Statement matcher. `matchStatementLines()` is pure and carries the test coverage. |
| `routes/ap.js` | HTTP surface, mounted at `/api/ap`. |

## Setup

1. **Run the migration.** The production database is **Supabase**
   (`aws-1-us-east-1.pooler.supabase.com`), not the retired Railway Postgres
   service — check `/api/health` if in doubt. Easiest path is the Supabase
   dashboard SQL Editor: paste the contents of
   `db/migrations/064_ap_bills.sql` and run it. Every statement is
   `IF NOT EXISTS`, so it is safe to re-run.

   To run it locally instead, put the Supabase session-pooler connection
   string in `.env` as `DATABASE_URL` first — the checked-in value points at
   the dead Railway proxy — then:

```bash
node -r dotenv/config scripts/run-sql.js db/migrations/064_ap_bills.sql
```

2. **Set the environment variables** (see `.env.example` for the full notes):

| Var | Required | Notes |
|---|---|---|
| `ANTHROPIC_API_KEY` | yes | Without it every upload stores but fails extraction. |
| `QBO_AP_DEFAULT_ACCOUNT` | yes | Chart-of-accounts **name**, e.g. `Purchases`. Uncoded lines fail to post without it. |
| `AP_INBOUND_SECRET` | for email intake | Shared secret for `POST /api/ap/inbound`. |
| `QBO_AP_TAX_CODE` | no | Defaults to `7` (Ontario HST). |
| `AP_EXTRACT_MODEL` | no | Defaults to `claude-opus-5`. |

3. **Verify the tax treatment on one real bill before trusting the rest.**
   Post a single supplier invoice, then open it in QuickBooks and check the
   total matches the paper. `postBillForDocument()` compares QBO's returned
   `TotalAmt` against the document total and writes a warning to
   `ap_documents.post_error` when they disagree, so a mismatch surfaces on
   the row rather than months later as a statement discrepancy — but the
   first one still deserves a human look. This is the same trap the Stripe
   fee `Purchase` hit in `lib/qbo-terminal-writeback.js`: QBO applies its
   own tax-exclusive default and adds 13% on top of an amount that already
   includes it.

4. **Point intake at it.** An Outlook rule that saves attachments to a
   watched folder, plus a small script POSTing to `/api/ap/inbound`, is the
   lowest-friction option. Until that exists, staff upload through
   `POST /api/ap/documents`.

## Endpoints

All under `/api/ap`. Staff auth except where noted.

| Method | Path | Notes |
|---|---|---|
| `POST` | `/documents` | Multipart, field `files`, up to 10. Extraction runs in the background. |
| `POST` | `/inbound` | Machine intake. `X-AP-Secret` header, not a JWT. |
| `GET` | `/documents` | Filters: `review_status`, `doc_kind`, `vendor_qbo_id`, `extract_status`, `posted`. |
| `GET` | `/documents/:id` | Header, lines, and statement if there is one. |
| `GET` | `/documents/:id/file` | The source PDF, for the review pane. |
| `POST` | `/documents/:id/extract` | Re-run extraction. Synchronous. Refused once posted. |
| `PATCH` | `/documents/:id` | Reviewer corrections. A `lines` array replaces all lines. |
| `GET` | `/vendors?q=` | QBO vendor search for the picker. |
| `POST` | `/documents/:id/vendor` | Assign the QBO vendor; `learn` (default true) teaches the alias. |
| `POST` | `/documents/:id/approve` | Checks vendor + lines are present first. |
| `POST` | `/documents/:id/reject` | |
| `POST` | `/documents/:id/post` | **Admin.** Creates the QBO Bill and attaches the PDF. |
| `POST` | `/documents/:id/purge-file` | **Admin.** Drops our PDF copy; refused unless QBO holds the attachment. |
| `GET` | `/statements` · `/statements/:id` | |
| `POST` | `/statements/:id/reconcile` | The diff. |
| `POST` | `/documents/:id/rebuild-statement` | Rebuild lines from stored extraction; does not re-call the model. |

## Design notes

**Money crosses the model boundary as strings.** Amounts come back exactly
as printed (`"1,234.56"`, `"(45.00)"`) and are parsed to integer cents in
`parseMoneyToCents`. Asking for JSON numbers would route every amount
through a float, and the drift shows up as one-cent statement mismatches.

**Two independent duplicate guards.** `content_sha256` catches the same PDF
arriving twice; a partial unique index on `(vendor_qbo_id, doc_number)`
catches the same invoice arriving as a different file. Before creating a
Bill, QBO is also queried for an existing one with that DocNumber under that
vendor — a bill entered by hand is adopted rather than duplicated.

**Vendors are never auto-created.** A typo'd name silently creating a
near-duplicate vendor is exactly what makes a statement impossible to
reconcile later. Unresolved vendors go to the review queue; assigning one
teaches `ap_vendor_aliases`, so the queue shrinks month over month.

**PDFs live in Postgres, then in QBO.** Railway's container filesystem is
ephemeral and the files-bridge is organized by job folder, which AP
documents are not. Once QBO holds the attachment, `purge-file` drops our
copy.

## Reconciliation output

Each statement line lands in one of five states:

| Status | Meaning |
|---|---|
| `matched` | In our books, amount agrees. |
| `amount_mismatch` | Both sides have it, amounts differ. |
| `missing` | On the statement, nowhere in our books. **The finding that matters.** |
| `unposted` | We hold the invoice, it just hasn't reached QBO. |
| `ignored` | Payments and balance-forward rows. |

Plus `extras` — bills in our books for the period the statement never
lists, which usually means a double entry on our side.

## Tests

```bash
node --test lib/ap-extract.test.js lib/ap-reconcile.test.js lib/ap-qbo-bills.test.js
```

46 tests, no network or database required. They cover the money parsers, the
statement matcher, and the Bill payload's tax treatment. The API call, the
QBO writes, and the HTTP layer are not covered — those need a real key and a
sandbox company.
