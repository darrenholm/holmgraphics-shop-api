-- 009_promote_job_helpers.sql
-- Schema bits supporting lib/promote-job.js: the helper that auto-promotes
-- an online order's project to "Ordered" + assigns it to production once
-- the order is paid AND has at least one design row.
--
-- Two changes — both idempotent:
--   1. projects.updated_at column. The promote helper writes
--      updated_at = NOW() so the staff Kanban can sort by recency.
--      No code currently references this column on projects, but adding
--      it via IF NOT EXISTS is safe whether or not it already exists.
--   2. Partial index on orders(job_id) WHERE paid_at IS NOT NULL.
--      The staff dashboard's "current jobs with paid online orders"
--      lookup benefits from this; the existing orders_job_idx covers all
--      rows including abandoned/unpaid carts that can outnumber paid
--      orders.
--
-- Safe to re-run.

-- ─── 1. projects.updated_at ──────────────────────────────────────────────────

ALTER TABLE projects
  ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW();

-- ─── 2. partial index for paid online orders ─────────────────────────────────

CREATE INDEX IF NOT EXISTS orders_paid_job_idx
  ON orders (job_id)
  WHERE paid_at IS NOT NULL;
