// routes/lookup.js
// Clients, Employees, Statuses, ProjectTypes — lookup/reference data.
// Rewritten for Railway Postgres (pg driver, $1..$n placeholders).
const express = require('express');
const { query } = require('../db/connection');
const { requireAuth, requireStaff } = require('../middleware/auth');
const router = express.Router();

// ─── GET /api/clients ────────────────────────────────────────────────────────
// Optional: ?search=smith&limit=200
//
// search is a case-insensitive substring match against company, fname, lname,
// email, AND phone (phone was added by migration 008 and was missed in the
// original WHERE clause -- without it, a search like "519-507" wouldn't find
// a client whose company/name doesn't already contain that digit run).
//
// Returns a flat array of client rows. Callers that need a total-match
// count beyond the limit can pass limit=1000 (the cap) and rely on
// rows.length, or hit a future /clients/count endpoint.
router.get('/clients', requireStaff, async (req, res) => {
  try {
    const { search } = req.query;
    let limit = parseInt(req.query.limit, 10);
    if (!Number.isFinite(limit) || limit <= 0) limit = 50;
    if (limit > 1000) limit = 1000;

    const params = [];
    let where = '';
    if (search) {
      params.push(`%${search}%`);
      // ILIKE on raw stored phone strings -- no format normalisation
      // because the column carries every punctuation convention we have
      // (519-507-3001, (519) 507-3001, 5195073001). A contiguous chunk
      // typed by the user matches any row containing that chunk literally.
      where = `WHERE company ILIKE $1
                  OR fname   ILIKE $1
                  OR lname   ILIKE $1
                  OR email   ILIKE $1
                  OR phone   ILIKE $1`;
    }
    params.push(limit);

    const rows = await query(
      `SELECT id, company AS company_name, fname AS first_name, lname AS last_name, email, phone
         FROM clients
         ${where}
        ORDER BY COALESCE(company, lname)
        LIMIT $${params.length}`,
      params
    );
    res.json(rows);
  } catch (e) {
    console.error('GET /clients:', e);
    res.status(500).json({ message: 'Failed to load clients', detail: e.message });
  }
});

// ─── GET /api/clients/:id ────────────────────────────────────────────────────
router.get('/clients/:id', requireAuth, async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    const [clients, addresses, phones] = await Promise.all([
      query(
        `SELECT id, company AS company_name, fname AS first_name,
                lname AS last_name, email
           FROM clients
          WHERE id = $1`,
        [id]
      ),
      query(
        `SELECT address1, address2, town AS city, province,
                postal_code AS postal, address_type AS type
           FROM client_addresses
          WHERE client_id = $1`,
        [id]
      ),
      query(
        `SELECT number AS phone_number, ext, phone_type AS type
           FROM client_phones
          WHERE client_id = $1`,
        [id]
      ),
    ]);
    if (!clients[0]) return res.status(404).json({ message: 'Client not found' });
    res.json({ ...clients[0], addresses, phones });
  } catch (e) {
    console.error('GET /clients/:id:', e);
    res.status(500).json({ message: 'Failed to load client', detail: e.message });
  }
});

// ─── POST /api/clients ───────────────────────────────────────────────────────
router.post('/clients', requireStaff, async (req, res) => {
  const { company, first_name, last_name, email } = req.body;
  if (!company && !last_name) return res.status(400).json({ message: 'Company name or last name required' });
  try {
    const rows = await query(
      `INSERT INTO clients (company, fname, lname, email)
       VALUES ($1, $2, $3, $4)
       RETURNING id`,
      [company || null, first_name || null, last_name || null, email || null]
    );
    res.status(201).json({ id: rows[0]?.id, message: 'Client created' });
  } catch (e) {
    res.status(500).json({ message: 'Failed to create client', detail: e.message });
  }
});

// ─── GET /api/employees ──────────────────────────────────────────────────────
router.get('/employees', requireStaff, async (req, res) => {
  try {
    const rows = await query(
      `SELECT id, first_name, last_name, email, role
         FROM employees
        WHERE active IS TRUE OR active IS NULL
        ORDER BY last_name, first_name`
    );
    res.json(rows);
  } catch (e) {
    console.error('GET /employees:', e);
    res.status(500).json({ message: 'Failed to load employees', detail: e.message });
  }
});

// ─── GET /api/statuses ───────────────────────────────────────────────────────
router.get('/statuses', requireAuth, async (req, res) => {
  try {
    const rows = await query(
      `SELECT id, name AS status_name
         FROM status
        ORDER BY sort_order, id`
    );
    res.json(rows);
  } catch (e) {
    console.error('GET /statuses:', e);
    res.status(500).json({ message: 'Failed to load statuses', detail: e.message });
  }
});

// ─── GET /api/project-types ──────────────────────────────────────────────────
router.get('/project-types', requireAuth, async (req, res) => {
  try {
    const rows = await query(
      `SELECT id, name AS type_name
         FROM project_type
        ORDER BY name`
    );
    res.json(rows);
  } catch (e) {
    console.error('GET /project-types:', e);
    res.status(500).json({ message: 'Failed to load project types', detail: e.message });
  }
});

module.exports = router;
