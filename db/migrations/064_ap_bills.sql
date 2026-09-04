-- 064_ap_bills.sql
-- Accounts-payable document intake: vendor invoices and monthly statements
-- captured from email/upload, extracted with Claude, reviewed by a human,
-- then posted to QBO as Bills with the source PDF attached.
--
-- Replaces forwarding to holmgraphics@qbodocs.com, which feeds QBO's
-- Receipts tray: that path captures vendor/date/total only, loses line
-- items and terms, and has no concept of a supplier statement. The whole
-- reason for keeping our own copy of every bill is `ap_statements` — once
-- each invoice is a row here we can diff a vendor's month-end statement
-- against what we actually booked, which QBO cannot do at all.
--
-- Money is stored in CENTS (integers) end to end, matching
-- 059_terminal_payments.sql. Convert to dollars only at the QBO boundary.
--
-- Safe to re-run.

-- ─── Vendor name aliasing ────────────────────────────────────────────────
-- Invoices spell the vendor differently than QBO does ("SANMAR CANADA ULC"
-- vs "SanMar Canada"). Resolving through this table means a vendor is
-- matched by hand exactly once, and every later document from them lands
-- on the right QBO vendor with no review prompt.
CREATE TABLE IF NOT EXISTS ap_vendor_aliases (
  id             SERIAL      PRIMARY KEY,
  -- Normalized (lowercased, punctuation-stripped) form of what appeared on
  -- the document. Normalization lives in lib/ap-extract.js so the rule sits
  -- with the code that applies it.
  alias_norm     TEXT        NOT NULL UNIQUE,
  vendor_qbo_id  TEXT        NOT NULL,
  vendor_name    TEXT        NOT NULL,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ─── Documents ───────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS ap_documents (
  id                SERIAL      PRIMARY KEY,

  -- ─── Intake ───────────────────────────────────────────────────────────
  source            TEXT        NOT NULL DEFAULT 'upload',  -- upload | email | folder
  original_filename TEXT,
  -- SHA-256 of the file bytes. The same PDF arriving twice (forwarded by
  -- two people, or a webhook retry) collapses onto one row instead of
  -- becoming a duplicate bill.
  content_sha256    TEXT        NOT NULL UNIQUE,
  mime_type         TEXT        NOT NULL DEFAULT 'application/pdf',
  byte_size         INT,
  -- The source PDF. Kept in Postgres rather than on disk because Railway
  -- containers have an ephemeral filesystem, and rather than on L:\ because
  -- the files-bridge is organized by job folder and AP documents aren't
  -- jobs. Nulled by the purge endpoint once QBO holds the attachment, so
  -- this table doesn't grow without bound.
  file_bytes        BYTEA,
  file_purged_at    TIMESTAMPTZ,

  doc_kind          TEXT        NOT NULL DEFAULT 'unknown',
                                -- invoice | statement | credit_note | unknown

  -- ─── Extraction ───────────────────────────────────────────────────────
  extract_status     TEXT       NOT NULL DEFAULT 'pending', -- pending | ok | failed
  extract_error      TEXT,
  extract_model      TEXT,
  extracted_at       TIMESTAMPTZ,
  -- Whatever the model returned, verbatim. Kept so a bad post can be
  -- diagnosed later without re-running (and re-paying for) extraction.
  extract_raw        JSONB,
  -- The model's own low/medium/high read on how clean the document was.
  -- Drives which rows get surfaced for review first.
  extract_confidence TEXT,

  -- ─── Normalized header (extraction fills it, a human may correct it) ──
  vendor_name       TEXT,
  vendor_qbo_id     TEXT,
  doc_number        TEXT,
  txn_date          DATE,
  due_date          DATE,
  terms             TEXT,
  currency          TEXT        NOT NULL DEFAULT 'CAD',
  subtotal_cents    INT,
  tax_cents         INT,
  total_cents       INT,
  memo              TEXT,

  -- ─── Review ───────────────────────────────────────────────────────────
  review_status     TEXT        NOT NULL DEFAULT 'needs_review',
                                -- needs_review | approved | rejected
  reviewed_by       INT         REFERENCES employees(id) ON DELETE SET NULL,
  reviewed_at       TIMESTAMPTZ,

  -- ─── QBO posting ──────────────────────────────────────────────────────
  qbo_bill_id       TEXT,
  qbo_attachable_id TEXT,
  posted_at         TIMESTAMPTZ,
  post_error        TEXT,

  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Second duplicate guard, independent of the file hash: the same invoice
-- number from the same vendor can arrive as a differently-rendered PDF
-- (re-issued, re-scanned, or emailed by two people). Partial so the many
-- rows still awaiting extraction — all NULL vendor/number — don't collide.
CREATE UNIQUE INDEX IF NOT EXISTS ap_documents_vendor_docnum_uniq
  ON ap_documents (vendor_qbo_id, doc_number)
  WHERE vendor_qbo_id IS NOT NULL
    AND doc_number IS NOT NULL
    AND doc_kind = 'invoice';

CREATE INDEX IF NOT EXISTS ap_documents_review_idx ON ap_documents (review_status, created_at DESC);
CREATE INDEX IF NOT EXISTS ap_documents_vendor_idx ON ap_documents (vendor_qbo_id, txn_date);
CREATE INDEX IF NOT EXISTS ap_documents_unposted_idx
  ON ap_documents (posted_at) WHERE posted_at IS NULL;

-- ─── Document lines ──────────────────────────────────────────────────────
-- The part qbodocs never captured. Account columns are nullable because a
-- freshly extracted line has a description and an amount but no QBO account
-- until it is coded, either by an alias rule or by the reviewer.
CREATE TABLE IF NOT EXISTS ap_document_lines (
  id             SERIAL  PRIMARY KEY,
  document_id    INT     NOT NULL REFERENCES ap_documents(id) ON DELETE CASCADE,
  line_no        INT     NOT NULL,
  description    TEXT,
  quantity       NUMERIC(14,4),
  unit_cents     INT,
  amount_cents   INT     NOT NULL,
  account_name   TEXT,
  account_qbo_id TEXT,
  -- QBO TaxCode id. NULL means "no tax on this line". Ontario HST is '7',
  -- the same code the invoice and salesreceipt paths use.
  tax_code       TEXT,
  UNIQUE (document_id, line_no)
);

CREATE INDEX IF NOT EXISTS ap_document_lines_doc_idx ON ap_document_lines (document_id);

-- ─── Statements ──────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS ap_statements (
  id                    SERIAL      PRIMARY KEY,
  -- The statement PDF itself, which is an ap_documents row with
  -- doc_kind='statement'.
  document_id           INT         NOT NULL UNIQUE
                                    REFERENCES ap_documents(id) ON DELETE CASCADE,
  vendor_name           TEXT,
  vendor_qbo_id         TEXT,
  statement_date        DATE,
  closing_balance_cents INT,
  reconciled_at         TIMESTAMPTZ,
  -- Counts by match_status as of the last reconcile run, so the list view
  -- can show "3 missing" without re-joining every line.
  summary               JSONB,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS ap_statement_lines (
  id                  SERIAL  PRIMARY KEY,
  statement_id        INT     NOT NULL REFERENCES ap_statements(id) ON DELETE CASCADE,
  line_no             INT     NOT NULL,
  doc_number          TEXT,
  txn_date            DATE,
  amount_cents        INT,
  kind                TEXT,   -- invoice | credit | payment | other
  -- Set by lib/ap-reconcile.js:
  --   matched         — in our books, amount agrees
  --   amount_mismatch — in our books, amount differs
  --   missing         — on the statement, never received or entered
  --   unposted        — extracted here but not yet pushed to QBO
  --   ignored         — payments and other non-invoice lines
  match_status        TEXT,
  matched_document_id INT     REFERENCES ap_documents(id) ON DELETE SET NULL,
  matched_qbo_bill_id TEXT,
  our_amount_cents    INT,
  note                TEXT,
  UNIQUE (statement_id, line_no)
);

CREATE INDEX IF NOT EXISTS ap_statement_lines_stmt_idx   ON ap_statement_lines (statement_id);
CREATE INDEX IF NOT EXISTS ap_statement_lines_status_idx ON ap_statement_lines (statement_id, match_status);
