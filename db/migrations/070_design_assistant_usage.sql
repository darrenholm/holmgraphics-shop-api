-- 070_design_assistant_usage.sql
-- Design Assistant (Claude chat on the staff job page) — one row per turn.
--
-- The assistant is billed per use on the Anthropic API rather than per seat,
-- so the only thing standing between a runaway session and a surprise bill is
-- this table: the route sums the current month before every call and refuses
-- once DESIGN_ASSISTANT_MONTHLY_CAP_USD is reached. It also answers "who is
-- using it, on which jobs, and what does it cost us".
--
-- cost_usd is an ESTIMATE computed from the token counts at list price. The
-- Anthropic Console invoice is the authority; this is for the cap and for a
-- rough per-job figure.
--
-- Safe to re-run.

CREATE TABLE IF NOT EXISTS design_assistant_usage (
  id                  BIGSERIAL     PRIMARY KEY,
  project_id          INT           NOT NULL,
  emp_id              INT,
  model               TEXT          NOT NULL,
  input_tokens        INT           NOT NULL DEFAULT 0,
  output_tokens       INT           NOT NULL DEFAULT 0,
  cache_read_tokens   INT           NOT NULL DEFAULT 0,
  cache_write_tokens  INT           NOT NULL DEFAULT 0,
  layouts_created     INT           NOT NULL DEFAULT 0,
  cost_usd            NUMERIC(10,4) NOT NULL DEFAULT 0,
  created_at          TIMESTAMPTZ   NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS design_assistant_usage_created_idx
  ON design_assistant_usage (created_at DESC);

CREATE INDEX IF NOT EXISTS design_assistant_usage_project_idx
  ON design_assistant_usage (project_id);
