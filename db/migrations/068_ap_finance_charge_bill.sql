-- 068_ap_finance_charge_bill.sql
-- The bill that carries a statement's finance charges.
--
-- Interest a supplier prints on a statement row is a real expense with no
-- invoice behind it. Migration 066 captured the figure so the reconciliation
-- could say a difference was interest rather than a mis-keyed invoice, but
-- entering it was still hand work every month, on every statement, for every
-- charged row — and the note telling the reviewer to do it is the same note
-- whether the charge is one row or a dozen.
--
-- ONE BILL PER STATEMENT, not one per row. That is how the money actually
-- arrives: the supplier does not invoice interest, they add it to a statement,
-- and a bookkeeper entering it by hand would write one bill with a line per
-- charged invoice. Rolling up also keeps the payable count honest — a dozen
-- $2 bills is noise in AP ageing.
--
-- The bill id is kept here rather than in ap_documents because there is no
-- document: nothing was received for this, it was derived from the statement.
-- It also makes the post idempotent, which matters because "Check again" is a
-- button a reviewer will press repeatedly.
--
-- Safe to re-run.

ALTER TABLE ap_statements
  ADD COLUMN IF NOT EXISTS finance_charge_bill_id TEXT,
  -- Total actually posted, so a statement re-read that finds a different
  -- figure can be spotted instead of silently disagreeing with QBO.
  ADD COLUMN IF NOT EXISTS finance_charge_cents   INT,
  ADD COLUMN IF NOT EXISTS finance_charge_at      TIMESTAMPTZ;
