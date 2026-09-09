-- Finance charges on a supplier statement.
--
-- SanMar prints interest on an overdue invoice as its own figure on that
-- invoice's statement row, and the balance due includes it. Without it the
-- reconciliation could only say "the amounts differ" and leave the reviewer to
-- work out by hand that the difference was interest — which is a real expense
-- needing its own bill, not a mis-keyed invoice.

ALTER TABLE ap_statement_lines
  ADD COLUMN IF NOT EXISTS finance_charge_cents INT;
