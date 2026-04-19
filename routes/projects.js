// routes/projects.js
// Projects + their children (notes, items, measurements, photos, status).
// Rewritten for Railway Postgres (pg driver, $1..$n placeholders).
const express = require('express');
const { query, queryOne } = require('../db/connection');
const { requireAuth, requireStaff } = require('../middleware/auth');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const router = express.Router();

// ─── File upload config (photos live on disk, not in DB) ─────────────────────
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    const dir = `uploads/jobs/${req.params.id}`;
    fs.mkdirSync(dir, { recursive: true });
    cb(null, dir);
  },
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname);
    cb(null, Date.now() + ext);
  }
});
const upload = multer({
  storage,
  limits: { fileSize: 20 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const allowed = /jpeg|jpg|png|gif|webp/;
    cb(null, allowed.test(path.extname(file.originalname).toLowerCase()));
  }
});

// ─── GET /api/projects ───────────────────────────────────────────────────────
router.get('/', requireAuth, async (req, res) => {
  try {
    const { clientId, search } = req.query;
    const params = [];
    const where = ['1=1'];

    if (req.user.role === 'client') {
      params.push(req.user.clientId);
      where.push(`p.client_id = $${params.length}`);
    } else if (clientId) {
      params.push(parseInt(clientId));
      where.push(`p.client_id = $${params.length}`);
    }

    if (search) {
      params.push(`%${search}%`);
      const i = params.length;
      where.push(`(
        CAST(p.id AS TEXT) ILIKE $${i}
        OR p.description ILIKE $${i}
        OR c.company ILIKE $${i}
        OR c.fname ILIKE $${i}
        OR c.lname ILIKE $${i}
      )`);
    }

    const rows = await query(
      `SELECT p.id,
              p.description AS project_name,
              p.client_id,
              p.status_id,
              p.project_type_id AS type_id,
              p.production_emp_id AS employee_id,
              p.created_date AS date_created,
              p.due_date,
              p.contact_name AS contact,
              p.contact_phone,
              COALESCE(c.company, CONCAT_WS(' ', c.fname, c.lname)) AS client_name,
              s.name AS status_name,
              pt.name AS project_type,
              CONCAT_WS(' ', e.first_name, e.last_name) AS assigned_to
         FROM projects p
         LEFT JOIN clients      c  ON p.client_id        = c.id
         LEFT JOIN status       s  ON p.status_id        = s.id
         LEFT JOIN project_type pt ON p.project_type_id  = pt.id
         LEFT JOIN employees    e  ON p.production_emp_id = e.id
        WHERE ${where.join(' AND ')}
        ORDER BY p.created_date DESC NULLS LAST, p.id DESC`,
      params
    );
    res.json(rows);
  } catch (e) {
    console.error('GET /projects:', e);
    res.status(500).json({ message: 'Failed to load projects', detail: e.message });
  }
});

// ─── GET /api/projects/:id ───────────────────────────────────────────────────
router.get('/:id', requireAuth, async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    const row = await queryOne(
      `SELECT p.id,
              p.description AS project_name,
              p.client_id,
              p.status_id,
              p.project_type_id AS type_id,
              p.production_emp_id AS employee_id,
              p.sales_emp_id AS sales_id,
              p.created_date AS date_created,
              p.due_date,
              p.contact_name AS contact,
              p.contact_phone,
              p.contact_email,
              COALESCE(c.company, CONCAT_WS(' ', c.fname, c.lname)) AS client_name,
              c.email AS client_email,
              s.name AS status_name,
              pt.name AS project_type,
              CONCAT_WS(' ', e.first_name, e.last_name) AS assigned_to
         FROM projects p
         LEFT JOIN clients      c  ON p.client_id        = c.id
         LEFT JOIN status       s  ON p.status_id        = s.id
         LEFT JOIN project_type pt ON p.project_type_id  = pt.id
         LEFT JOIN employees    e  ON p.production_emp_id = e.id
        WHERE p.id = $1`,
      [id]
    );
    if (!row) return res.status(404).json({ message: 'Project not found' });
    if (req.user.role === 'client' && row.client_id !== req.user.clientId) {
      return res.status(403).json({ message: 'Access denied' });
    }

    const phones = await query(
      `SELECT number AS phone_number, ext, phone_type
         FROM client_phones
        WHERE client_id = $1`,
      [row.client_id]
    );

    const measurements = await query(
      `SELECT id, item, height_in AS height, width_in AS width,
              comment AS notes
         FROM measurements
        WHERE project_id = $1`,
      [id]
    );

    res.json({ ...row, client_phones: phones, measurements });
  } catch (e) {
    console.error('GET /projects/:id:', e);
    res.status(500).json({ message: 'Failed to load project', detail: e.message });
  }
});

// ─── POST /api/projects ──────────────────────────────────────────────────────
router.post('/', requireStaff, async (req, res) => {
  const {
    project_name, client_id, project_type_id, status_id,
    assigned_employee_id, due_date, contact, contact_phone, contact_email,
  } = req.body;
  if (!project_name || !client_id) {
    return res.status(400).json({ message: 'project_name and client_id are required' });
  }
  try {
    const rows = await query(
      `INSERT INTO projects (
          description, client_id, project_type_id, status_id,
          production_emp_id, due_date, contact_name, contact_phone,
          contact_email, created_date
       ) VALUES (
          $1, $2, $3, $4,
          $5, $6, $7, $8,
          $9, CURRENT_DATE
       )
       RETURNING id`,
      [
        project_name,
        parseInt(client_id),
        project_type_id ? parseInt(project_type_id) : null,
        status_id ? parseInt(status_id) : null,
        assigned_employee_id ? parseInt(assigned_employee_id) : null,
        due_date ? new Date(due_date) : null,
        contact || null,
        contact_phone || null,
        contact_email || null,
      ]
    );
    res.status(201).json({ id: rows[0]?.id, message: 'Project created' });
  } catch (e) {
    console.error('POST /projects:', e);
    res.status(500).json({ message: 'Failed to create project', detail: e.message });
  }
});

// ─── PUT /api/projects/:id ───────────────────────────────────────────────────
router.put('/:id', requireStaff, async (req, res) => {
  const id = parseInt(req.params.id);
  const {
    project_name, client_id, project_type_id, status_id,
    assigned_employee_id, due_date, contact, contact_phone, contact_email,
  } = req.body;
  try {
    await query(
      `UPDATE projects
          SET description       = $1,
              client_id         = $2,
              project_type_id   = $3,
              status_id         = $4,
              production_emp_id = $5,
              due_date          = $6,
              contact_name      = $7,
              contact_phone     = $8,
              contact_email     = $9
        WHERE id = $10`,
      [
        project_name,
        parseInt(client_id),
        project_type_id ? parseInt(project_type_id) : null,
        status_id ? parseInt(status_id) : null,
        assigned_employee_id ? parseInt(assigned_employee_id) : null,
        due_date ? new Date(due_date) : null,
        contact || null,
        contact_phone || null,
        contact_email || null,
        id,
      ]
    );
    res.json({ message: 'Project updated' });
  } catch (e) {
    console.error('PUT /projects/:id:', e);
    res.status(500).json({ message: 'Failed to update project', detail: e.message });
  }
});

// ─── GET /api/projects/:id/notes ─────────────────────────────────────────────
router.get('/:id/notes', requireAuth, async (req, res) => {
  try {
    const rows = await query(
      `SELECT id, note AS note_text, created_at AS note_date,
              'Staff' AS employee_name
         FROM notes
        WHERE project_id = $1
        ORDER BY created_at DESC NULLS LAST, id DESC`,
      [parseInt(req.params.id)]
    );
    res.json(rows);
  } catch (e) {
    res.status(500).json({ message: 'Failed to load notes', detail: e.message });
  }
});

// ─── POST /api/projects/:id/notes ────────────────────────────────────────────
router.post('/:id/notes', requireAuth, async (req, res) => {
  const { text } = req.body;
  if (!text?.trim()) return res.status(400).json({ message: 'Note text required' });
  try {
    await query(
      `INSERT INTO notes (project_id, note, created_at)
       VALUES ($1, $2, NOW())`,
      [parseInt(req.params.id), text.trim()]
    );
    res.status(201).json({ message: 'Note added' });
  } catch (e) {
    res.status(500).json({ message: 'Failed to add note', detail: e.message });
  }
});

// ─── POST /api/projects/:id/status ───────────────────────────────────────────
// Updates the project's status and logs the change in audit_log.
router.post('/:id/status', requireStaff, async (req, res) => {
  const { statusId } = req.body;
  const projectId = parseInt(req.params.id);
  if (!statusId) return res.status(400).json({ message: 'statusId required' });
  try {
    // Capture old value for a proper audit entry.
    const current = await queryOne(
      `SELECT status_id FROM projects WHERE id = $1`,
      [projectId]
    );
    if (!current) return res.status(404).json({ message: 'Project not found' });

    await query(
      `UPDATE projects SET status_id = $1 WHERE id = $2`,
      [parseInt(statusId), projectId]
    );
    await query(
      `INSERT INTO audit_log
         (project_id, employee_id, field_changed, old_value, new_value, changed_at)
       VALUES
         ($1, $2, 'status_id', $3, $4, NOW())`,
      [
        projectId,
        req.user?.id || null,
        current.status_id != null ? String(current.status_id) : null,
        String(statusId),
      ]
    );
    res.json({ message: 'Status updated' });
  } catch (e) {
    console.error('POST /projects/:id/status:', e);
    res.status(500).json({ message: 'Failed to update status', detail: e.message });
  }
});

// ─── GET /api/projects/:id/items ─────────────────────────────────────────────
router.get('/:id/items', requireAuth, async (req, res) => {
  try {
    const rows = await query(
      `SELECT id, description AS item_name, qty AS quantity,
              price AS unit_price, ext_price AS total
         FROM items
        WHERE project_id = $1
        ORDER BY id`,
      [parseInt(req.params.id)]
    );
    res.json(rows);
  } catch (e) {
    res.status(500).json({ message: 'Failed to load items', detail: e.message });
  }
});

// ─── POST /api/projects/:id/items ────────────────────────────────────────────
router.post('/:id/items', requireStaff, async (req, res) => {
  const { description, qty, price, total } = req.body;
  if (!description?.trim()) return res.status(400).json({ message: 'Description required' });
  try {
    await query(
      `INSERT INTO items (project_id, description, qty, price, ext_price)
       VALUES ($1, $2, $3, $4, $5)`,
      [
        parseInt(req.params.id),
        description.trim(),
        parseFloat(qty) || 1,
        parseFloat(price) || 0,
        parseFloat(total) || 0,
      ]
    );
    res.status(201).json({ message: 'Item added' });
  } catch (e) {
    res.status(500).json({ message: 'Failed to add item', detail: e.message });
  }
});

// ─── POST /api/projects/:id/measurements ─────────────────────────────────────
router.post('/:id/measurements', requireStaff, async (req, res) => {
  const { item, width, height, notes } = req.body;
  try {
    await query(
      `INSERT INTO measurements (project_id, item, width_in, height_in, comment)
       VALUES ($1, $2, $3, $4, $5)`,
      [
        parseInt(req.params.id),
        item || null,
        width != null ? parseFloat(width) : null,
        height != null ? parseFloat(height) : null,
        notes || null,
      ]
    );
    res.status(201).json({ message: 'Measurement added' });
  } catch (e) {
    res.status(500).json({ message: 'Failed to add measurement', detail: e.message });
  }
});

// ─── GET /api/projects/:id/photos ────────────────────────────────────────────
// Photos are stored on the filesystem, not in the DB.
router.get('/:id/photos', requireAuth, async (req, res) => {
  const dir = `uploads/jobs/${req.params.id}`;
  try {
    if (!fs.existsSync(dir)) return res.json([]);
    const files = fs.readdirSync(dir).map(f => ({
      filename: f,
      url: `/uploads/jobs/${req.params.id}/${f}`,
      uploaded: fs.statSync(`${dir}/${f}`).mtime,
    }));
    res.json(files);
  } catch (e) {
    res.status(500).json({ message: 'Failed to load photos', detail: e.message });
  }
});

router.post('/:id/photos', requireStaff, upload.array('photos', 20), async (req, res) => {
  try {
    const files = req.files.map(f => ({
      filename: f.filename,
      url: `/uploads/jobs/${req.params.id}/${f.filename}`,
    }));
    res.status(201).json({ message: `${files.length} photo(s) uploaded`, files });
  } catch (e) {
    res.status(500).json({ message: 'Failed to upload photos', detail: e.message });
  }
});

router.delete('/:id/photos/:filename', requireStaff, async (req, res) => {
  const filePath = `uploads/jobs/${req.params.id}/${req.params.filename}`;
  try {
    if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
    res.json({ message: 'Photo deleted' });
  } catch (e) {
    res.status(500).json({ message: 'Failed to delete photo', detail: e.message });
  }
});

module.exports = router;
