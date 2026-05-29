-- 030_quote_sheet_items.sql
-- Internal quoting worksheet attached to a project (job). Staff enter
-- cost per unit + per-row markup; sale price defaults to cost × markup
-- but is stored explicitly so it can be overridden without losing the
-- cost/markup record. Once happy with the sheet, staff can promote
-- rows into the existing `items` table at sale price (the customer-
-- facing line items used by the QB invoice flow).
--
-- Forward compat: a `source_po_item_id` column will be added later
-- when the PO system lands, to auto-fill cost_per_unit from the most
-- recent PO line for that item.
--
-- Safe to re-run.

CREATE TABLE IF NOT EXISTS quote_sheet_items (
  id             SERIAL PRIMARY KEY,
  project_id     INT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  item           TEXT NOT NULL DEFAULT '',
  qty            NUMERIC(12,3) NOT NULL DEFAULT 1,
  cost_per_unit  NUMERIC(12,2) NOT NULL DEFAULT 0,
  markup         NUMERIC(6,3)  NOT NULL DEFAULT 2,
  sale_per_unit  NUMERIC(12,2) NOT NULL DEFAULT 0,
  notes          TEXT,
  position       INT NOT NULL DEFAULT 0,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS quote_sheet_items_project_idx
  ON quote_sheet_items (project_id, position);
