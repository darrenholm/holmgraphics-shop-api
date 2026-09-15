// routes/design-assistant.js
// Staff-only Design Assistant (Claude) endpoints, mounted at /api/design-assistant.
//
//   GET  /status                   — is it configured, and this month's spend vs cap
//   POST /projects/:id/chat        — one staff message → reply + layouts
//
// The conversation is held by the browser and posted back whole on every turn
// (see lib/design-assistant.js for why). Files never pass through here: the
// browser reads logos from, and saves layouts to, the files-bridge itself.
//
// Spend guard: DESIGN_ASSISTANT_MONTHLY_CAP_USD (default 100). Checked before
// each call against design_assistant_usage; one turn can overshoot it by that
// turn's cost, which is cents to a dollar or two.

'use strict';

const express = require('express');
const Anthropic = require('@anthropic-ai/sdk');
const { query, queryOne } = require('../db/connection');
const { requireStaff } = require('../middleware/auth');
const da = require('../lib/design-assistant');

const router = express.Router();

function capUsd() {
  const n = Number(process.env.DESIGN_ASSISTANT_MONTHLY_CAP_USD);
  return Number.isFinite(n) && n >= 0 ? n : 100;
}

async function monthSpendUsd() {
  const row = await queryOne(
    `SELECT COALESCE(SUM(cost_usd), 0)::float AS spend
       FROM design_assistant_usage
      WHERE created_at >= date_trunc('month', NOW())`
  );
  return Math.round((Number(row?.spend) || 0) * 100) / 100;
}

router.get('/status', requireStaff, async (_req, res) => {
  try {
    res.json({
      configured: da.isConfigured(),
      month_spend_usd: await monthSpendUsd(),
      cap_usd: capUsd(),
    });
  } catch (e) {
    console.error('GET /design-assistant/status:', e);
    res.status(500).json({ error: 'Could not load Design Assistant status' });
  }
});

router.post('/projects/:id/chat', requireStaff, async (req, res) => {
  const projectId = parseInt(req.params.id, 10);
  if (!Number.isInteger(projectId)) return res.status(400).json({ error: 'Bad job number' });
  if (!da.isConfigured()) {
    return res.status(503).json({ error: 'Design Assistant is not set up yet (no Anthropic API key on the server).' });
  }

  try {
    const spend = await monthSpendUsd();
    if (spend >= capUsd()) {
      return res.status(429).json({
        error: `Design Assistant has reached this month's spending limit ($${capUsd()}). Ask Darren to raise it.`,
      });
    }

    const project = await queryOne(
      `SELECT p.id, p.description AS project_name, p.due_date,
              p.contact_name AS contact,
              COALESCE(c.company, CONCAT_WS(' ', c.fname, c.lname)) AS client_name,
              s.name AS status_name, pt.name AS project_type
         FROM projects p
         LEFT JOIN clients      c  ON p.client_id       = c.id
         LEFT JOIN status       s  ON p.status_id       = s.id
         LEFT JOIN project_type pt ON p.project_type_id = pt.id
        WHERE p.id = $1`,
      [projectId]
    );
    if (!project) return res.status(404).json({ error: 'Job not found' });

    const [measurements, items, notes] = await Promise.all([
      query(
        `SELECT item, width_in AS width, height_in AS height, comment AS notes
           FROM measurements WHERE project_id = $1 ORDER BY id`,
        [projectId]
      ),
      query(
        `SELECT description, qty FROM items WHERE project_id = $1 ORDER BY id`,
        [projectId]
      ),
      query(
        `SELECT note, created_at FROM notes
          WHERE project_id = $1
          ORDER BY created_at DESC NULLS LAST, id DESC
          LIMIT 15`,
        [projectId]
      ),
    ]);
    project.measurements = measurements;

    const files = Array.isArray(req.body?.files)
      ? req.body.files
          .filter((f) => f && typeof f.name === 'string')
          .slice(0, 60)
          .map((f) => ({ name: f.name }))
      : [];

    const jobContext = da.buildJobContext({ project, notes, items, files });
    const result = await da.runTurn({ messages: req.body?.messages, jobContext });

    const empId = Number.isInteger(req.user?.id) ? req.user.id : null;
    await query(
      `INSERT INTO design_assistant_usage
         (project_id, emp_id, model, input_tokens, output_tokens,
          cache_read_tokens, cache_write_tokens, layouts_created, cost_usd)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [
        projectId, empId, result.model,
        result.usage.input_tokens || 0,
        result.usage.output_tokens || 0,
        result.usage.cache_read_input_tokens || 0,
        result.usage.cache_creation_input_tokens || 0,
        result.layouts.length,
        result.costUsd,
      ]
    ).catch((e) => console.error('design_assistant_usage insert failed:', e.message));

    res.json({
      reply: result.reply,
      layouts: result.layouts,
      newMessages: result.newMessages,
      stop_reason: result.stopReason,
      cost_usd: result.costUsd,
      month_spend_usd: Math.round((spend + result.costUsd) * 100) / 100,
      cap_usd: capUsd(),
    });
  } catch (e) {
    if (e instanceof Anthropic.RateLimitError) {
      return res.status(429).json({ error: 'Claude is busy right now — try again in a minute.' });
    }
    if (e instanceof Anthropic.BadRequestError) {
      console.error('design-assistant 400 from Claude:', e.message);
      return res.status(400).json({ error: `Claude rejected the request: ${e.message}` });
    }
    if (e instanceof Anthropic.AuthenticationError) {
      return res.status(503).json({ error: 'The Anthropic API key on the server is not valid.' });
    }
    if (e instanceof Anthropic.APIError) {
      console.error('design-assistant API error:', e.status, e.message);
      return res.status(502).json({ error: 'Claude had a problem answering — try again.' });
    }
    if (/messages|Conversation|role|content/.test(e.message || '')) {
      return res.status(400).json({ error: e.message });
    }
    console.error('POST /design-assistant chat:', e);
    res.status(500).json({ error: 'Design Assistant failed', detail: e.message });
  }
});

module.exports = router;
