// routes/scheduling.js
//
// Job-progress scheduling endpoints. Four phases all wired up here so
// the calendar (Phase 1), per-job task list (Phase 2), templates
// (Phase 3), and resource-conflict view (Phase 4) share state without
// a cross-file dance.
//
// All endpoints require staff auth (the customer-facing proof routes
// stay over in routes/project-proofs.js). Mounted at /api by
// server.js; full paths live in the JSDoc above each handler.

'use strict';

const express = require('express');
const { query, queryOne } = require('../db/connection');
const { requireStaff } = require('../middleware/auth');

const router = express.Router();
router.use(express.json());

// ─── Helpers ─────────────────────────────────────────────────────────────

// Coerces a YYYY-MM-DD string to a Date or returns null. Used in body
// validation so we never write a malformed date to a DATE column.
function asDate(v) {
  if (v === null || v === undefined || v === '') return null;
  const s = String(v).slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return null;
  const d = new Date(s + 'T12:00:00.000Z'); // noon UTC dodges DST roll-over
  return Number.isNaN(d.getTime()) ? null : s;
}
function asInt(v) {
  if (v === null || v === undefined || v === '') return null;
  const n = parseInt(v, 10);
  return Number.isInteger(n) ? n : null;
}
function asNumeric(v) {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

// ═════════════════════════════════════════════════════════════════════════
// PHASE 4 (foundation) — Resources
// ═════════════════════════════════════════════════════════════════════════

// GET /api/scheduling/resources — list active resources.
router.get('/scheduling/resources', requireStaff, async (req, res, next) => {
  try {
    const includeInactive = req.query.include_inactive === 'true';
    const rows = await query(
      `SELECT id, name, resource_type, daily_capacity_hours, color, active, notes
         FROM resources
        ${includeInactive ? '' : 'WHERE active'}
        ORDER BY resource_type, name`
    );
    res.json({ resources: rows });
  } catch (e) { next(e); }
});

// POST /api/scheduling/resources — add a resource.
router.post('/scheduling/resources', requireStaff, async (req, res, next) => {
  try {
    const { name, resource_type, daily_capacity_hours, color, notes } = req.body || {};
    if (!name || !resource_type) {
      return res.status(400).json({ message: 'name + resource_type required' });
    }
    const row = await queryOne(
      `INSERT INTO resources (name, resource_type, daily_capacity_hours, color, notes)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING *`,
      [name, resource_type, asNumeric(daily_capacity_hours) ?? 8.0, color || null, notes || null]
    );
    res.status(201).json(row);
  } catch (e) { next(e); }
});

// PATCH /api/scheduling/resources/:id — edit / retire.
router.patch('/scheduling/resources/:id', requireStaff, async (req, res, next) => {
  try {
    const id = asInt(req.params.id);
    if (!id) return res.status(400).json({ message: 'invalid id' });
    const fields = [];
    const vals = [];
    const allow = ['name', 'resource_type', 'daily_capacity_hours', 'color', 'notes', 'active'];
    for (const k of allow) {
      if (k in (req.body || {})) {
        fields.push(`${k} = $${fields.length + 1}`);
        vals.push(req.body[k]);
      }
    }
    if (fields.length === 0) return res.status(400).json({ message: 'no fields' });
    vals.push(id);
    const row = await queryOne(
      `UPDATE resources SET ${fields.join(', ')} WHERE id = $${vals.length} RETURNING *`,
      vals
    );
    if (!row) return res.status(404).json({ message: 'not found' });
    res.json(row);
  } catch (e) { next(e); }
});

// ═════════════════════════════════════════════════════════════════════════
// PHASE 1 — Install schedule (calendar)
// ═════════════════════════════════════════════════════════════════════════

// GET /api/scheduling/installs?from=YYYY-MM-DD&to=YYYY-MM-DD
// Returns every scheduled install in the date range, joined with the
// project's name + client. Used by the /schedule calendar view.
router.get('/scheduling/installs', requireStaff, async (req, res, next) => {
  try {
    const from = asDate(req.query.from) || asDate(new Date().toISOString().slice(0, 10));
    // Default window: 6 weeks forward from `from`.
    const fromDate = new Date(from + 'T12:00:00.000Z');
    const defaultTo = new Date(fromDate.getTime() + 42 * 86400000).toISOString().slice(0, 10);
    const to = asDate(req.query.to) || defaultTo;

    // ::text on every DATE column so the JSON response is plain
    // YYYY-MM-DD — the pg driver otherwise returns Date objects that
    // serialise to "2026-06-04T00:00:00.000Z", which <input type="date">
    // can't render and which break the calendar's date-key bucketing.
    const rows = await query(
      `SELECT i.id, i.project_id,
              i.install_date::text AS install_date,
              i.start_time::text   AS start_time,
              i.duration_hours, i.crew_resource_id, i.notes,
              i.weather_blocked, i.status, i.updated_at,
              p.description AS project_name,
              p.status_id   AS project_status_id,
              p.due_date::text AS due_date,
              COALESCE(c.company, CONCAT_WS(' ', c.fname, c.lname)) AS client_name,
              r.name        AS crew_name,
              r.color       AS crew_color
         FROM project_install_schedule i
         JOIN projects p ON p.id = i.project_id
         LEFT JOIN clients   c ON c.id = p.client_id
         LEFT JOIN resources r ON r.id = i.crew_resource_id
        WHERE i.install_date BETWEEN $1 AND $2
        ORDER BY i.install_date, COALESCE(i.start_time, '08:00'::time)`,
      [from, to]
    );
    res.json({ from, to, installs: rows });
  } catch (e) { next(e); }
});

// GET /api/scheduling/calendar-tasks?from=&to=
//
// Returns every job_task overlapping the date range, with the
// "effective resource" already resolved:
//   • If t.resource_id is set, use that.
//   • Else if t.assigned_emp_id is set, use that employee's
//     person-resource (one per employee since migration 039).
//   • Else effective_resource_id is NULL → renders in the "unassigned"
//     bucket on the calendar.
// This lets the calendar swimlanes render task bars under the same
// resource row as installs, without forcing the caller to do a
// second join.
router.get('/scheduling/calendar-tasks', requireStaff, async (req, res, next) => {
  try {
    const from = asDate(req.query.from) || new Date().toISOString().slice(0, 10);
    const fromDate = new Date(from + 'T12:00:00.000Z');
    const to = asDate(req.query.to) || new Date(fromDate.getTime() + 42 * 86400000).toISOString().slice(0, 10);

    const rows = await query(
      `SELECT t.id, t.project_id, t.step_order, t.name, t.task_kind,
              t.planned_start::text AS planned_start,
              t.planned_end::text   AS planned_end,
              t.actual_start::text  AS actual_start,
              t.actual_end::text    AS actual_end,
              t.duration_hours, t.status,
              t.assigned_emp_id, t.resource_id,
              COALESCE(t.resource_id, r_via_emp.id) AS effective_resource_id,
              COALESCE(r_direct.color, r_via_emp.color) AS effective_color,
              COALESCE(r_direct.name,  r_via_emp.name)  AS effective_resource_name,
              p.description AS project_name,
              COALESCE(c.company, CONCAT_WS(' ', c.fname, c.lname)) AS client_name,
              TRIM(CONCAT_WS(' ', e.first_name, e.last_name)) AS assigned_name
         FROM job_tasks t
         JOIN projects p ON p.id = t.project_id
         LEFT JOIN clients   c ON c.id = p.client_id
         LEFT JOIN employees e ON e.id = t.assigned_emp_id
         LEFT JOIN resources r_direct ON r_direct.id = t.resource_id
         LEFT JOIN resources r_via_emp ON r_via_emp.employee_id = t.assigned_emp_id
        WHERE t.planned_start IS NOT NULL
          AND t.planned_end   IS NOT NULL
          AND t.planned_start <= $2
          AND t.planned_end   >= $1
          AND t.status NOT IN ('completed', 'skipped')
        ORDER BY t.planned_start, t.id`,
      [from, to]
    );
    res.json({ from, to, tasks: rows });
  } catch (e) { next(e); }
});

// GET /api/scheduling/installs/by-project/:projectId — every install for one job.
router.get('/scheduling/installs/by-project/:projectId', requireStaff, async (req, res, next) => {
  try {
    const pid = asInt(req.params.projectId);
    if (!pid) return res.status(400).json({ message: 'invalid project id' });
    const rows = await query(
      `SELECT i.id, i.project_id,
              i.install_date::text AS install_date,
              i.start_time::text   AS start_time,
              i.duration_hours, i.crew_resource_id, i.notes,
              i.weather_blocked, i.status,
              i.scheduled_by, i.created_at, i.updated_at,
              r.name AS crew_name, r.color AS crew_color
         FROM project_install_schedule i
         LEFT JOIN resources r ON r.id = i.crew_resource_id
        WHERE i.project_id = $1
        ORDER BY i.install_date, COALESCE(i.start_time, '08:00'::time)`,
      [pid]
    );
    res.json({ installs: rows });
  } catch (e) { next(e); }
});

// POST /api/scheduling/installs — schedule a job for a date.
router.post('/scheduling/installs', requireStaff, async (req, res, next) => {
  try {
    const projectId = asInt(req.body.project_id);
    const installDate = asDate(req.body.install_date);
    if (!projectId || !installDate) {
      return res.status(400).json({ message: 'project_id + install_date required' });
    }
    const row = await queryOne(
      `INSERT INTO project_install_schedule
         (project_id, install_date, start_time, duration_hours,
          crew_resource_id, notes, weather_blocked, status, scheduled_by)
       VALUES ($1, $2, $3, $4, $5, $6, COALESCE($7, FALSE), COALESCE($8, 'scheduled'), $9)
       RETURNING *`,
      [
        projectId, installDate,
        req.body.start_time || null,
        asNumeric(req.body.duration_hours),
        asInt(req.body.crew_resource_id),
        req.body.notes || null,
        req.body.weather_blocked,
        req.body.status,
        req.user?.id || null,
      ]
    );
    res.status(201).json(row);
  } catch (e) { next(e); }
});

// PATCH /api/scheduling/installs/:id — move a job, set crew, mark complete, etc.
router.patch('/scheduling/installs/:id', requireStaff, async (req, res, next) => {
  try {
    const id = asInt(req.params.id);
    if (!id) return res.status(400).json({ message: 'invalid id' });
    const allow = {
      install_date:     (v) => asDate(v),
      start_time:       (v) => v || null,
      duration_hours:   (v) => asNumeric(v),
      crew_resource_id: (v) => asInt(v),
      notes:            (v) => v || null,
      weather_blocked:  (v) => !!v,
      status:           (v) => v || null,
    };
    const fields = [], vals = [];
    for (const [k, coerce] of Object.entries(allow)) {
      if (k in (req.body || {})) {
        fields.push(`${k} = $${fields.length + 1}`);
        vals.push(coerce(req.body[k]));
      }
    }
    if (!fields.length) return res.status(400).json({ message: 'no fields' });
    vals.push(id);
    const row = await queryOne(
      `UPDATE project_install_schedule SET ${fields.join(', ')}
        WHERE id = $${vals.length} RETURNING *`,
      vals
    );
    if (!row) return res.status(404).json({ message: 'not found' });
    res.json(row);
  } catch (e) { next(e); }
});

// DELETE /api/scheduling/installs/:id
router.delete('/scheduling/installs/:id', requireStaff, async (req, res, next) => {
  try {
    const id = asInt(req.params.id);
    if (!id) return res.status(400).json({ message: 'invalid id' });
    const r = await query(`DELETE FROM project_install_schedule WHERE id = $1`, [id]);
    res.status(204).end();
  } catch (e) { next(e); }
});

// ═════════════════════════════════════════════════════════════════════════
// PHASE 2 — Job tasks (per-job Schedule tab)
// ═════════════════════════════════════════════════════════════════════════

// GET /api/scheduling/job-tasks/:projectId — every task on this project,
// ordered. Frontend renders a mini-Gantt.
router.get('/scheduling/job-tasks/:projectId', requireStaff, async (req, res, next) => {
  try {
    const pid = asInt(req.params.projectId);
    if (!pid) return res.status(400).json({ message: 'invalid project id' });
    const rows = await query(
      `SELECT t.id, t.project_id, t.template_id, t.step_order, t.name, t.task_kind,
              t.planned_start::text AS planned_start,
              t.planned_end::text   AS planned_end,
              t.actual_start::text  AS actual_start,
              t.actual_end::text    AS actual_end,
              t.duration_hours, t.assigned_emp_id, t.resource_id,
              t.depends_on_task_id, t.status, t.notes,
              t.created_at, t.updated_at,
              TRIM(CONCAT_WS(' ', e.first_name, e.last_name)) AS assigned_name,
              r.name  AS resource_name,
              r.color AS resource_color
         FROM job_tasks t
         LEFT JOIN employees e ON e.id = t.assigned_emp_id
         LEFT JOIN resources r ON r.id = t.resource_id
        WHERE t.project_id = $1
        ORDER BY t.step_order, t.id`,
      [pid]
    );
    res.json({ tasks: rows });
  } catch (e) { next(e); }
});

// POST /api/scheduling/job-tasks — create an ad-hoc task on a project.
router.post('/scheduling/job-tasks', requireStaff, async (req, res, next) => {
  try {
    const pid = asInt(req.body.project_id);
    if (!pid || !req.body.name) {
      return res.status(400).json({ message: 'project_id + name required' });
    }
    // Auto-pick a step_order one past the current max so manual inserts
    // land at the end of the timeline without colliding.
    const stepRow = await queryOne(
      `SELECT COALESCE(MAX(step_order), 0) AS m FROM job_tasks WHERE project_id = $1`,
      [pid]
    );
    const step = asInt(req.body.step_order) ?? (Number(stepRow.m) + 10);
    const row = await queryOne(
      `INSERT INTO job_tasks
         (project_id, step_order, name, task_kind,
          planned_start, planned_end, duration_hours,
          assigned_emp_id, resource_id, depends_on_task_id, status, notes)
       VALUES ($1, $2, $3, COALESCE($4, 'labor'),
               $5, $6, $7, $8, $9, $10, COALESCE($11, 'pending'), $12)
       RETURNING *`,
      [
        pid, step, req.body.name, req.body.task_kind,
        asDate(req.body.planned_start), asDate(req.body.planned_end),
        asNumeric(req.body.duration_hours),
        asInt(req.body.assigned_emp_id), asInt(req.body.resource_id),
        asInt(req.body.depends_on_task_id),
        req.body.status, req.body.notes || null,
      ]
    );
    res.status(201).json(row);
  } catch (e) { next(e); }
});

// PATCH /api/scheduling/job-tasks/:id
router.patch('/scheduling/job-tasks/:id', requireStaff, async (req, res, next) => {
  try {
    const id = asInt(req.params.id);
    if (!id) return res.status(400).json({ message: 'invalid id' });
    const allow = {
      name:               (v) => v,
      task_kind:          (v) => v,
      step_order:         (v) => asInt(v),
      planned_start:      (v) => asDate(v),
      planned_end:        (v) => asDate(v),
      actual_start:       (v) => asDate(v),
      actual_end:         (v) => asDate(v),
      duration_hours:     (v) => asNumeric(v),
      assigned_emp_id:    (v) => asInt(v),
      resource_id:        (v) => asInt(v),
      depends_on_task_id: (v) => asInt(v),
      status:             (v) => v,
      notes:              (v) => v ?? null,
    };
    const fields = [], vals = [];
    for (const [k, coerce] of Object.entries(allow)) {
      if (k in (req.body || {})) {
        fields.push(`${k} = $${fields.length + 1}`);
        vals.push(coerce(req.body[k]));
      }
    }
    if (!fields.length) return res.status(400).json({ message: 'no fields' });
    vals.push(id);
    const row = await queryOne(
      `UPDATE job_tasks SET ${fields.join(', ')}
        WHERE id = $${vals.length} RETURNING *`,
      vals
    );
    if (!row) return res.status(404).json({ message: 'not found' });
    res.json(row);
  } catch (e) { next(e); }
});

// DELETE /api/scheduling/job-tasks/:id
router.delete('/scheduling/job-tasks/:id', requireStaff, async (req, res, next) => {
  try {
    const id = asInt(req.params.id);
    if (!id) return res.status(400).json({ message: 'invalid id' });
    await query(`DELETE FROM job_tasks WHERE id = $1`, [id]);
    res.status(204).end();
  } catch (e) { next(e); }
});

// ═════════════════════════════════════════════════════════════════════════
// PHASE 3 — Templates + apply
// ═════════════════════════════════════════════════════════════════════════

// GET /api/scheduling/templates — list with step counts.
router.get('/scheduling/templates', requireStaff, async (req, res, next) => {
  try {
    const rows = await query(
      `SELECT t.id, t.name, t.project_type_id, t.active, t.notes, t.created_at,
              (SELECT COUNT(*) FROM task_template_steps s WHERE s.template_id = t.id) AS step_count
         FROM task_templates t
        WHERE t.active OR $1
        ORDER BY t.name`,
      [req.query.include_inactive === 'true']
    );
    res.json({ templates: rows });
  } catch (e) { next(e); }
});

// GET /api/scheduling/templates/:id — full template w/ steps.
router.get('/scheduling/templates/:id', requireStaff, async (req, res, next) => {
  try {
    const id = asInt(req.params.id);
    if (!id) return res.status(400).json({ message: 'invalid id' });
    const tpl = await queryOne(`SELECT * FROM task_templates WHERE id = $1`, [id]);
    if (!tpl) return res.status(404).json({ message: 'not found' });
    const steps = await query(
      `SELECT s.*, r.name AS default_resource_name, r.color AS default_resource_color
         FROM task_template_steps s
         LEFT JOIN resources r ON r.id = s.default_resource_id
        WHERE s.template_id = $1
        ORDER BY s.step_order`,
      [id]
    );
    res.json({ ...tpl, steps });
  } catch (e) { next(e); }
});

// POST /api/scheduling/templates — create
router.post('/scheduling/templates', requireStaff, async (req, res, next) => {
  try {
    if (!req.body?.name) return res.status(400).json({ message: 'name required' });
    const row = await queryOne(
      `INSERT INTO task_templates (name, project_type_id, notes)
       VALUES ($1, $2, $3) RETURNING *`,
      [req.body.name, asInt(req.body.project_type_id), req.body.notes || null]
    );
    res.status(201).json(row);
  } catch (e) { next(e); }
});

// PATCH /api/scheduling/templates/:id
router.patch('/scheduling/templates/:id', requireStaff, async (req, res, next) => {
  try {
    const id = asInt(req.params.id);
    if (!id) return res.status(400).json({ message: 'invalid id' });
    const allow = ['name', 'project_type_id', 'active', 'notes'];
    const fields = [], vals = [];
    for (const k of allow) {
      if (k in (req.body || {})) {
        fields.push(`${k} = $${fields.length + 1}`);
        vals.push(req.body[k]);
      }
    }
    if (!fields.length) return res.status(400).json({ message: 'no fields' });
    vals.push(id);
    const row = await queryOne(
      `UPDATE task_templates SET ${fields.join(', ')}
        WHERE id = $${vals.length} RETURNING *`,
      vals
    );
    if (!row) return res.status(404).json({ message: 'not found' });
    res.json(row);
  } catch (e) { next(e); }
});

// POST /api/scheduling/templates/:id/steps — append a step
router.post('/scheduling/templates/:id/steps', requireStaff, async (req, res, next) => {
  try {
    const tid = asInt(req.params.id);
    if (!tid || !req.body?.name) return res.status(400).json({ message: 'name required' });
    const stepRow = await queryOne(
      `SELECT COALESCE(MAX(step_order), 0) AS m FROM task_template_steps WHERE template_id = $1`,
      [tid]
    );
    const order = asInt(req.body.step_order) ?? (Number(stepRow.m) + 10);
    const row = await queryOne(
      `INSERT INTO task_template_steps
         (template_id, step_order, name, default_duration_days, default_resource_id,
          depends_on_order, task_kind, notes)
       VALUES ($1, $2, $3, COALESCE($4, 1.0), $5, $6, COALESCE($7, 'labor'), $8)
       RETURNING *`,
      [
        tid, order, req.body.name,
        asNumeric(req.body.default_duration_days),
        asInt(req.body.default_resource_id),
        asInt(req.body.depends_on_order),
        req.body.task_kind, req.body.notes || null,
      ]
    );
    res.status(201).json(row);
  } catch (e) { next(e); }
});

// PATCH /api/scheduling/template-steps/:id
router.patch('/scheduling/template-steps/:id', requireStaff, async (req, res, next) => {
  try {
    const id = asInt(req.params.id);
    if (!id) return res.status(400).json({ message: 'invalid id' });
    const allow = ['name', 'step_order', 'default_duration_days', 'default_resource_id',
                   'depends_on_order', 'task_kind', 'notes'];
    const fields = [], vals = [];
    for (const k of allow) {
      if (k in (req.body || {})) {
        fields.push(`${k} = $${fields.length + 1}`);
        vals.push(req.body[k]);
      }
    }
    if (!fields.length) return res.status(400).json({ message: 'no fields' });
    vals.push(id);
    const row = await queryOne(
      `UPDATE task_template_steps SET ${fields.join(', ')}
        WHERE id = $${vals.length} RETURNING *`,
      vals
    );
    if (!row) return res.status(404).json({ message: 'not found' });
    res.json(row);
  } catch (e) { next(e); }
});

router.delete('/scheduling/template-steps/:id', requireStaff, async (req, res, next) => {
  try {
    const id = asInt(req.params.id);
    if (!id) return res.status(400).json({ message: 'invalid id' });
    await query(`DELETE FROM task_template_steps WHERE id = $1`, [id]);
    res.status(204).end();
  } catch (e) { next(e); }
});

// POST /api/scheduling/apply-template
// Body: { project_id, template_id, anchor: 'due_date'|'install_date'|'today', target_date? }
//
// Generates job_tasks from the template, calculating planned dates by
// scheduling backwards from the anchor (due_date or scheduled install
// date). Sequential by default — each step's planned_start =
// previous step's planned_end. Existing job_tasks on the project are
// LEFT IN PLACE; if the user wants a clean slate they DELETE first.
router.post('/scheduling/apply-template', requireStaff, async (req, res, next) => {
  try {
    const pid = asInt(req.body.project_id);
    const tid = asInt(req.body.template_id);
    if (!pid || !tid) return res.status(400).json({ message: 'project_id + template_id required' });

    const proj = await queryOne(
      `SELECT p.id, p.due_date,
              (SELECT MIN(install_date) FROM project_install_schedule
                WHERE project_id = p.id AND status NOT IN ('cancelled','completed')) AS install_date
         FROM projects p WHERE p.id = $1`,
      [pid]
    );
    if (!proj) return res.status(404).json({ message: 'project not found' });

    const steps = await query(
      `SELECT * FROM task_template_steps WHERE template_id = $1 ORDER BY step_order`,
      [tid]
    );
    if (steps.length === 0) return res.status(400).json({ message: 'template has no steps' });

    // Pick anchor date.
    const anchor = req.body.anchor || 'due_date';
    let anchorDate = null;
    if (anchor === 'install_date' && proj.install_date) {
      anchorDate = new Date(proj.install_date);
    } else if (anchor === 'due_date' && proj.due_date) {
      anchorDate = new Date(proj.due_date);
    } else if (anchor === 'target' && req.body.target_date) {
      const d = asDate(req.body.target_date);
      anchorDate = d ? new Date(d + 'T12:00:00.000Z') : null;
    }
    // Fallback: forward-schedule from today.
    const forwardMode = !anchorDate;
    if (forwardMode) anchorDate = new Date(new Date().toISOString().slice(0, 10) + 'T12:00:00.000Z');

    // Total template length in days — for backward scheduling we set the
    // last step's planned_end to anchorDate, then walk backwards.
    const totalDays = steps.reduce((sum, s) => sum + Number(s.default_duration_days), 0);

    // Map template step_order → { start, end } so depends_on lookups work.
    const dateBySo = new Map();
    let cursor = new Date(anchorDate);
    if (!forwardMode) {
      // Backward: start at anchor, walk through steps in REVERSE.
      for (let i = steps.length - 1; i >= 0; i--) {
        const s = steps[i];
        const end = new Date(cursor);
        const start = new Date(cursor);
        start.setUTCDate(start.getUTCDate() - Math.ceil(Number(s.default_duration_days)));
        dateBySo.set(s.step_order, { start, end });
        cursor = new Date(start);
      }
    } else {
      // Forward: anchor is the start; walk forward.
      for (const s of steps) {
        const start = new Date(cursor);
        const end = new Date(cursor);
        end.setUTCDate(end.getUTCDate() + Math.ceil(Number(s.default_duration_days)));
        dateBySo.set(s.step_order, { start, end });
        cursor = new Date(end);
      }
    }

    function toIso(d) { return d.toISOString().slice(0, 10); }

    // Re-base step_order so this template's steps land AFTER any
    // existing job_tasks on the project (matters when applying multiple
    // templates to one job — e.g. design + install templates).
    const existing = await queryOne(
      `SELECT COALESCE(MAX(step_order), 0) AS m FROM job_tasks WHERE project_id = $1`, [pid]
    );
    const base = Number(existing.m);

    // Insert each step. Two-pass: first insert without dependencies to
    // get IDs, then second pass updates depends_on_task_id by looking
    // up the prerequisite's new id.
    const idByOrder = new Map();
    for (const s of steps) {
      const sched = dateBySo.get(s.step_order);
      const row = await queryOne(
        `INSERT INTO job_tasks
           (project_id, template_id, step_order, name, task_kind,
            planned_start, planned_end,
            duration_hours, resource_id, notes, status)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 'pending')
         RETURNING id, step_order`,
        [
          pid, tid, base + s.step_order, s.name, s.task_kind,
          toIso(sched.start), toIso(sched.end),
          Number(s.default_duration_days) * 8.0,   // crude h→d conversion at 8h/day
          s.default_resource_id, s.notes,
        ]
      );
      idByOrder.set(s.step_order, row.id);
    }
    // Second pass: wire dependencies.
    for (const s of steps) {
      if (s.depends_on_order && idByOrder.has(s.depends_on_order)) {
        const myId  = idByOrder.get(s.step_order);
        const depId = idByOrder.get(s.depends_on_order);
        await query(
          `UPDATE job_tasks SET depends_on_task_id = $1 WHERE id = $2`,
          [depId, myId]
        );
      }
    }

    // Audit log entry so the Audit tab reflects the template application.
    await query(
      `INSERT INTO audit_log (project_id, employee_id, field_changed, old_value, new_value)
       VALUES ($1, $2, 'job_tasks_template_applied', $3, $4)`,
      [pid, req.user?.id || null, '(none)', String(tid)]
    );

    res.status(201).json({
      ok: true,
      project_id: pid,
      template_id: tid,
      created: idByOrder.size,
      anchor: forwardMode ? 'today (forward)' : anchor,
      first_planned_start: toIso(dateBySo.get(steps[0].step_order).start),
      last_planned_end:    toIso(dateBySo.get(steps[steps.length - 1].step_order).end),
    });
  } catch (e) { next(e); }
});

// ═════════════════════════════════════════════════════════════════════════
// PHASE 4 — Resource conflict + per-resource view
// ═════════════════════════════════════════════════════════════════════════

// GET /api/scheduling/resource-load?from=YYYY-MM-DD&to=YYYY-MM-DD
//
// Aggregates job_tasks AND install schedule by (resource_id, date),
// returning a daily allocation grid. Plus a flag per cell when the
// allocation exceeds the resource's daily_capacity_hours. The frontend
// renders this as a heat-map overlay on the calendar.
router.get('/scheduling/resource-load', requireStaff, async (req, res, next) => {
  try {
    const from = asDate(req.query.from) || new Date().toISOString().slice(0, 10);
    const fromDate = new Date(from + 'T12:00:00.000Z');
    const to = asDate(req.query.to) || new Date(fromDate.getTime() + 28 * 86400000).toISOString().slice(0, 10);

    // Generate a per-day allocation from job_tasks (planned_start..planned_end
    // expanded into a date series) UNION install schedule entries.
    const rows = await query(
      `WITH date_series AS (
         SELECT generate_series($1::date, $2::date, '1 day'::interval)::date AS day
       ),
       task_load AS (
         -- Each task contributes to the day's allocation under its
         -- effective resource: explicit t.resource_id if set, else the
         -- assignee's person-resource. Tasks with neither don't count
         -- toward any resource's daily load.
         SELECT COALESCE(t.resource_id, r_emp.id) AS resource_id,
                d.day,
                -- Distribute task's hours across its date span (ceil-day count)
                COALESCE(t.duration_hours, 8.0) /
                  GREATEST(1, t.planned_end - t.planned_start + 1) AS hours
           FROM job_tasks t
           LEFT JOIN resources r_emp ON r_emp.employee_id = t.assigned_emp_id
           JOIN date_series d ON d.day BETWEEN t.planned_start AND t.planned_end
          WHERE (t.resource_id IS NOT NULL OR r_emp.id IS NOT NULL)
            AND t.task_kind = 'labor'
            AND t.status NOT IN ('completed', 'skipped')
       ),
       install_load AS (
         SELECT i.crew_resource_id AS resource_id,
                i.install_date    AS day,
                COALESCE(i.duration_hours, 8.0) AS hours
           FROM project_install_schedule i
          WHERE i.crew_resource_id IS NOT NULL
            AND i.status NOT IN ('cancelled', 'completed')
            AND i.install_date BETWEEN $1::date AND $2::date
       ),
       combined AS (
         SELECT * FROM task_load
         UNION ALL
         SELECT * FROM install_load
       )
       SELECT c.resource_id,
              c.day::text AS day,
              SUM(c.hours)::numeric(6,2)  AS hours_allocated,
              r.daily_capacity_hours,
              r.name,
              r.color,
              r.resource_type,
              (SUM(c.hours) > r.daily_capacity_hours) AS overbooked
         FROM combined c
         JOIN resources r ON r.id = c.resource_id
        GROUP BY c.resource_id, c.day, r.daily_capacity_hours, r.name, r.color, r.resource_type
        ORDER BY c.resource_id, c.day`,
      [from, to]
    );
    res.json({ from, to, load: rows });
  } catch (e) { next(e); }
});

// GET /api/scheduling/by-resource/:resourceId?from=&to= — what's this
// resource doing across the window? Tasks + installs together.
router.get('/scheduling/by-resource/:resourceId', requireStaff, async (req, res, next) => {
  try {
    const rid = asInt(req.params.resourceId);
    if (!rid) return res.status(400).json({ message: 'invalid resource id' });
    const from = asDate(req.query.from) || new Date().toISOString().slice(0, 10);
    const fromDate = new Date(from + 'T12:00:00.000Z');
    const to = asDate(req.query.to) || new Date(fromDate.getTime() + 14 * 86400000).toISOString().slice(0, 10);

    // Tasks reach this resource two ways: direct resource_id link OR
    // via assigned_emp_id when this resource IS the person's row. The
    // person-resource link comes from resources.employee_id (set on
    // INSERT by the sync trigger in migration 039).
    const tasks = await query(
      `SELECT t.id, t.project_id, t.name, t.task_kind,
              t.planned_start::text AS planned_start,
              t.planned_end::text   AS planned_end,
              t.status, t.duration_hours,
              p.description AS project_name,
              TRIM(CONCAT_WS(' ', e.first_name, e.last_name)) AS assigned_name,
              COALESCE(c.company, CONCAT_WS(' ', c.fname, c.lname)) AS client_name
         FROM job_tasks t
         JOIN projects p ON p.id = t.project_id
         LEFT JOIN clients c ON c.id = p.client_id
         LEFT JOIN employees e ON e.id = t.assigned_emp_id
        WHERE (
                t.resource_id = $1
             OR t.assigned_emp_id = (SELECT employee_id FROM resources WHERE id = $1)
              )
          AND t.planned_start <= $3 AND t.planned_end >= $2
        ORDER BY t.planned_start`,
      [rid, from, to]
    );
    const installs = await query(
      `SELECT i.id, i.project_id,
              i.install_date::text AS install_date,
              i.start_time::text   AS start_time,
              i.duration_hours, i.status, i.notes,
              p.description AS project_name,
              COALESCE(c.company, CONCAT_WS(' ', c.fname, c.lname)) AS client_name
         FROM project_install_schedule i
         JOIN projects p ON p.id = i.project_id
         LEFT JOIN clients c ON c.id = p.client_id
        WHERE i.crew_resource_id = $1
          AND i.install_date BETWEEN $2 AND $3
        ORDER BY i.install_date, COALESCE(i.start_time, '08:00'::time)`,
      [rid, from, to]
    );
    res.json({ resource_id: rid, from, to, tasks, installs });
  } catch (e) { next(e); }
});

module.exports = router;
