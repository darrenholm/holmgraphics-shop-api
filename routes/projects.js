// routes/projects.js
// Projects + their children (notes, items, measurements, photos, status).
// Rewritten for Railway Postgres (pg driver, $1..$n placeholders).
const express = require('express');
const db = require('../db/connection');
const { query, queryOne } = db;
const { requireAuth, requireStaff, requireAdmin } = require('../middleware/auth');
const { runBackfill } = require('../db/backfill-photos');
const mailer = require('../lib/customer-mailer');
const multer = require('multer');
const path = require('path');
const ftp = require('basic-ftp');
const { Readable } = require('stream');
const router = express.Router();

// ─── WHC photo storage config ────────────────────────────────────────────────
// Photos live on WHC's cPanel hosting under public_html/shop-uploads/jobs/<id>/
// because Railway's filesystem is ephemeral (wiped on redeploy). The API
// streams uploaded files to WHC via FTPS (explicit, port 21 + AUTH TLS).
const WHC_HOST        = process.env.WHC_FTP_HOST;
const WHC_PORT        = parseInt(process.env.WHC_FTP_PORT || '21', 10);
const WHC_USER        = process.env.WHC_FTP_USER;
const WHC_PASS        = process.env.WHC_FTP_PASSWORD;
const WHC_SECURE      = process.env.WHC_FTP_SECURE !== 'false'; // FTPS by default
const WHC_REMOTE_BASE = (process.env.WHC_REMOTE_BASE || 'public_html/shop-uploads/jobs').replace(/\/$/, '');
const WHC_PUBLIC_BASE = (process.env.WHC_PUBLIC_BASE || 'https://holmgraphics.ca/shop-uploads/jobs').replace(/\/$/, '');

function whcConfigured() {
  return Boolean(WHC_HOST && WHC_USER && WHC_PASS);
}

async function connectFtp(timeoutMs = 15000) {
  if (!whcConfigured()) throw new Error('WHC FTP env vars not configured');
  const client = new ftp.Client(timeoutMs);
  client.ftp.verbose = false;
  // WHC's shared hosting serves a TLS cert for the box's own hostname
  // (srv22.swhc.ca), not our vanity ftp.holmgraphics.ca alias. The connection
  // is still encrypted, and we have to use the vanity hostname for cPanel
  // to route auth to the right account — so skip strict hostname matching.
  await client.access({
    host:     WHC_HOST,
    port:     WHC_PORT,
    user:     WHC_USER,
    password: WHC_PASS,
    secure:   WHC_SECURE,
    secureOptions: WHC_SECURE ? {
      // Trust the cert even though its CN/altnames don't include our vanity host.
      checkServerIdentity: () => undefined,
    } : undefined,
  });
  return client;
}

// ─── File upload config ──────────────────────────────────────────────────────
// Memory storage: buffer each file in RAM, then stream to WHC via FTPS.
// Never touches Railway's ephemeral filesystem.
const upload = multer({
  storage: multer.memoryStorage(),
  limits:  { fileSize: 20 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const allowed = /jpeg|jpg|png|gif|webp/;
    cb(null, allowed.test(path.extname(file.originalname).toLowerCase()));
  },
});

// Allowed gallery categories — must match the CHECK constraint in
// db/migrations/001_project_photos.sql.
const PHOTO_CATEGORIES = ['signs_led', 'vehicle_wraps', 'apparel', 'printing', 'other'];
function normalizeCategory(raw) {
  const v = String(raw || '').trim().toLowerCase();
  return PHOTO_CATEGORIES.includes(v) ? v : 'other';
}

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
              -- client_folder_name is what the files-bridge should use. Falls
              -- back to the derived name when no manual override is set.
              COALESCE(NULLIF(c.files_folder, ''),
                       c.company,
                       CONCAT_WS(' ', c.fname, c.lname)) AS client_folder_name,
              c.files_folder AS client_folder_override,
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

// ─── GET /api/projects/qb-items ──────────────────────────────────────────────
// Active QuickBooks item catalog for the job-detail line-item autocomplete.
// Reads from the `qb_items` table (populated separately — either manually or
// by a future QB sync job).
//
// MUST be defined before `/:id` or Express matches "qb-items" as an :id.
// Public (no requireAuth) — the frontend fetch at
// src/routes/jobs/[id]/+page.svelte:159 doesn't send the auth token.
router.get('/qb-items', async (req, res) => {
  try {
    const items = await query(
      `SELECT id, name, item_type, category, price, description
         FROM qb_items
        WHERE is_active = TRUE
        ORDER BY category ASC, name ASC`
    );
    res.json(items);
  } catch (err) {
    console.error('GET /projects/qb-items:', err);
    res.status(500).json({ error: err.message });
  }
});

// ─── GET /api/projects/gallery ───────────────────────────────────────────────
// PUBLIC — no auth. Used by holmgraphics.ca/gallery.html.
// Returns every photo marked show_in_gallery=true with its category, the
// public URL, and the parent project's description. No client info.
// Optional ?category=<cat> filter; otherwise returns everything.
// NOTE: must be declared before /:id so Express doesn't match "gallery"
// as an :id param.
router.get('/gallery', async (req, res) => {
  const wanted = req.query.category
    ? normalizeCategory(req.query.category)
    : null;
  try {
    const rows = await query(
      `SELECT ph.id,
              ph.project_id,
              ph.filename,
              ph.category,
              ph.uploaded_at,
              p.description AS project_description
         FROM project_photos ph
         JOIN projects p ON p.id = ph.project_id
        WHERE ph.show_in_gallery = TRUE
          ${wanted ? `AND ph.category = $1` : ''}
        ORDER BY ph.uploaded_at DESC, ph.id DESC`,
      wanted ? [wanted] : []
    );
    const out = rows.map((r) => ({
      id:          r.id,
      project_id:  r.project_id,
      category:    r.category,
      description: r.project_description,
      uploaded:    r.uploaded_at,
      url:         `${WHC_PUBLIC_BASE}/${r.project_id}/${encodeURIComponent(r.filename)}`,
    }));
    res.json(out);
  } catch (e) {
    console.error('GET /gallery:', e);
    res.status(500).json({ message: 'Failed to load gallery', detail: e.message });
  }
});

// ─── GET /api/projects/photos/all ────────────────────────────────────────────
// ADMIN-ONLY. Returns every photo in the system with its parent project's
// description + client name. Powers the bulk gallery curation page in the
// shop app (/admin/gallery-curate). Sorted newest-first.
//
// Optional ?unpublished=1 narrows to rows where show_in_gallery=false so an
// admin can blow through the backlog without scrolling past already-curated
// photos.
//
// MUST be declared before /:id so Express doesn't match "photos" as :id.
router.get('/photos/all', requireAdmin, async (req, res) => {
  const onlyUnpublished = req.query.unpublished === '1' || req.query.unpublished === 'true';
  try {
    const rows = await query(
      `SELECT ph.id,
              ph.project_id,
              ph.filename,
              ph.category,
              ph.show_in_gallery,
              ph.uploaded_at,
              p.description AS project_description,
              COALESCE(c.company, CONCAT_WS(' ', c.fname, c.lname)) AS client_name
         FROM project_photos ph
         JOIN projects p ON p.id = ph.project_id
         LEFT JOIN clients c ON c.id = p.client_id
        ${onlyUnpublished ? 'WHERE ph.show_in_gallery = FALSE' : ''}
        ORDER BY ph.uploaded_at DESC, ph.id DESC`
    );
    const out = rows.map((r) => ({
      id:                  r.id,
      project_id:          r.project_id,
      project_description: r.project_description,
      client_name:         r.client_name,
      filename:            r.filename,
      category:            r.category,
      show_in_gallery:     r.show_in_gallery,
      uploaded:            r.uploaded_at,
      url:                 `${WHC_PUBLIC_BASE}/${r.project_id}/${encodeURIComponent(r.filename)}`,
    }));
    res.json(out);
  } catch (e) {
    console.error('GET /photos/all:', e);
    res.status(500).json({ message: 'Failed to load photos', detail: e.message });
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
              p.po_number,
              COALESCE(c.company, CONCAT_WS(' ', c.fname, c.lname)) AS client_name,
              -- client_folder_name is what the files-bridge should use. Falls
              -- back to the derived name when no manual override is set.
              COALESCE(NULLIF(c.files_folder, ''),
                       c.company,
                       CONCAT_WS(' ', c.fname, c.lname)) AS client_folder_name,
              c.files_folder AS client_folder_override,
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

    // Decorations from any online order linked to this project. Empty array
    // for staff-created projects (no online order → no order_decorations
    // rows). position_name COALESCEs print_location.name with the custom
    // string the customer typed when picking "Other" at checkout, so the
    // frontend always has a label to render. Joining `designs` gives the
    // artwork file metadata so the job page can link straight to the
    // file via the holm:// protocol handler.
    const decorations = await query(
      `SELECT od.id                                  AS id,
              od.design_id                           AS design_id,
              COALESCE(pl.name, od.custom_location)  AS position_name,
              od.width_in,
              od.height_in,
              d.name                                 AS design_name,
              d.artwork_filename,
              d.artwork_path
         FROM order_decorations od
         JOIN orders            o  ON o.id = od.order_id
         LEFT JOIN print_locations pl ON pl.id = od.print_location_id
         LEFT JOIN designs         d  ON d.id  = od.design_id
        WHERE o.job_id = $1
        ORDER BY od.id`,
      [id]
    );

    // Financial summary for the linked online order, when one exists.
    // Staff-created projects have no orders row → orderRow is null and
    // we omit the order_summary key entirely (vs returning null) so the
    // frontend can do a simple {#if project.order_summary} gate.
    //
    // items_subtotal on `orders` is garments-only per the migration 008
    // comment ("Garment cost only — decoration cost lives on
    // order_decorations"). Decorations + setup fees are summed from
    // order_decorations so the frontend can render the breakdown the
    // customer saw at checkout.
    //
    // tax_rate_pct is derived from the actual taxed total rather than a
    // separate stored column — keeps the math honest if rounding ever
    // makes the stored rate not exactly match what tax / pre_tax yields.
    const orderRow = await queryOne(
      `SELECT o.order_number,
              o.items_subtotal::numeric                AS items_subtotal,
              o.shipping_total::numeric                AS shipping_total,
              o.tax_total::numeric                     AS tax_total,
              o.grand_total::numeric                   AS grand_total,
              o.fulfillment_method,
              o.paid_at,
              o.qb_payment_id,
              o.notification_email,
              (SELECT COALESCE(SUM(decoration_cost + setup_fee), 0)::numeric
                 FROM order_decorations
                WHERE order_id = o.id)                 AS decorations_subtotal
         FROM orders o
        WHERE o.job_id = $1
        ORDER BY o.id DESC
        LIMIT 1`,
      [id]
    );

    let order_summary;
    if (orderRow) {
      const items   = Number(orderRow.items_subtotal)       || 0;
      const decos   = Number(orderRow.decorations_subtotal) || 0;
      const ship    = Number(orderRow.shipping_total)       || 0;
      const tax     = Number(orderRow.tax_total)            || 0;
      const preTax  = items + decos + ship;
      const ratePct = preTax > 0 ? Number(((tax / preTax) * 100).toFixed(2)) : 0;
      order_summary = {
        order_number:         orderRow.order_number,
        items_subtotal:       items,
        decorations_subtotal: decos,
        shipping_total:       ship,
        tax_total:            tax,
        tax_rate_pct:         ratePct,
        grand_total:          Number(orderRow.grand_total) || 0,
        fulfillment_method:   orderRow.fulfillment_method,
        paid_at:              orderRow.paid_at,
        qb_payment_id:        orderRow.qb_payment_id,
        notification_email:   orderRow.notification_email,
      };
    }

    res.json({
      ...row,
      client_phones: phones,
      measurements,
      decorations,
      ...(order_summary ? { order_summary } : {}),
    });
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
    po_number,
  } = req.body;
  if (!project_name || !client_id) {
    return res.status(400).json({ message: 'project_name and client_id are required' });
  }
  try {
    const rows = await query(
      `INSERT INTO projects (
          description, client_id, project_type_id, status_id,
          production_emp_id, due_date, contact_name, contact_phone,
          contact_email, po_number, created_date
       ) VALUES (
          $1, $2, $3, $4,
          $5, $6, $7, $8,
          $9, $10, CURRENT_DATE
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
        po_number ? String(po_number).trim() || null : null,
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
    po_number,
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
              contact_email     = $9,
              po_number         = $10
        WHERE id = $11`,
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
        po_number ? String(po_number).trim() || null : null,
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
// LEFT JOIN employees so the staff name comes from notes.created_by when the
// row has it. Historical rows (pre-attribution fix) have created_by NULL and
// fall back to the literal 'Staff' — the COALESCE preserves that behaviour
// rather than rendering "—" or empty.
router.get('/:id/notes', requireAuth, async (req, res) => {
  try {
    const rows = await query(
      `SELECT n.id,
              n.note AS note_text,
              n.created_at AS note_date,
              COALESCE(
                NULLIF(TRIM(CONCAT_WS(' ', e.first_name, e.last_name)), ''),
                'Staff'
              ) AS employee_name
         FROM notes n
         LEFT JOIN employees e ON e.id = n.created_by
        WHERE n.project_id = $1
        ORDER BY n.created_at DESC NULLS LAST, n.id DESC`,
      [parseInt(req.params.id)]
    );
    res.json(rows);
  } catch (e) {
    res.status(500).json({ message: 'Failed to load notes', detail: e.message });
  }
});

// ─── POST /api/projects/:id/notes ────────────────────────────────────────────
// requireStaff (not requireAuth): a customer JWT also carries an `id` field,
// so without the role gate we would silently write a customer id into
// notes.created_by — exactly the silent-NULL class of bug the previous
// attribution attempt suffered. Guarding here ensures req.user.id refers to
// employees(id). If it somehow doesn't, throw 500 rather than insert garbage.
router.post('/:id/notes', requireStaff, async (req, res) => {
  const { text } = req.body;
  if (!text?.trim()) return res.status(400).json({ message: 'Note text required' });
  const employeeId = req.user?.id;
  if (!Number.isInteger(employeeId)) {
    console.error('POST /projects/:id/notes: requireStaff passed but req.user.id missing', req.user);
    return res.status(500).json({ message: 'Auth context missing employee id' });
  }
  try {
    await query(
      `INSERT INTO notes (project_id, note, created_by, created_at)
       VALUES ($1, $2, $3, NOW())`,
      [parseInt(req.params.id), text.trim(), employeeId]
    );
    res.status(201).json({ message: 'Note added' });
  } catch (e) {
    res.status(500).json({ message: 'Failed to add note', detail: e.message });
  }
});

// ─── POST /api/projects/:id/status ───────────────────────────────────────────
// Updates the project's status and logs the change in audit_log. If the
// project is linked to an online order AND the new status is one with a
// customer-facing email (Ordered/Proofing/Pickup-or-Delivery), fires the
// transactional email post-commit. Idempotent via email_log — same status
// won't double-send. Email failure is logged but never bubbles up to the
// staff who clicked the button.
router.post('/:id/status', requireStaff, async (req, res) => {
  const { statusId } = req.body;
  const projectId = parseInt(req.params.id);
  if (!statusId) return res.status(400).json({ message: 'statusId required' });
  try {
    const newStatusId = parseInt(statusId);

    // Capture old value for a proper audit entry.
    const current = await queryOne(
      `SELECT status_id FROM projects WHERE id = $1`,
      [projectId]
    );
    if (!current) return res.status(404).json({ message: 'Project not found' });

    await query(
      `UPDATE projects SET status_id = $1 WHERE id = $2`,
      [newStatusId, projectId]
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
        String(newStatusId),
      ]
    );

    // Fire any transactional email tied to this status. The dispatcher is
    // a no-op for status_id values that don't have a tracked email kind,
    // and idempotent for the ones that do — safe to call unconditionally.
    // Look up the linked online order; pickup and ship orders use the same
    // orders.id, only one row per project (see schema in 008).
    const orderRow = await queryOne(
      `SELECT id FROM orders WHERE job_id = $1 LIMIT 1`,
      [projectId]
    );
    if (orderRow) {
      // Fire-and-forget: never blocks the staff response, never throws.
      mailer.sendForOrderStatus({ orderId: orderRow.id, statusId: newStatusId, db })
        .catch((err) => console.warn(`status-email dispatch failed:`, err.message));
    }

    res.json({ message: 'Status updated' });
  } catch (e) {
    console.error('POST /projects/:id/status:', e);
    res.status(500).json({ message: 'Failed to update status', detail: e.message });
  }
});

// ─── GET /api/projects/:id/items ─────────────────────────────────────────────
// Returns BOTH manual `items` rows (staff-entered, editable) and the read-only
// mirror of `order_items` for any online order linked to this project. Online
// orders never write into `items` — they're checkout-derived rows attached to
// the project via orders.job_id. Without this UNION the job-detail page shows
// "No items recorded" for online orders even though they have line items.
//
// Each row carries a `source`:
//   * 'project' — staff manual entry. Editable via PUT/DELETE /items/:itemId.
//   * 'order'   — online-order line item. Read-only here; edit via order admin.
// Frontend should hide edit/delete controls for source='order'.
router.get('/:id/items', requireAuth, async (req, res) => {
  try {
    const projectId = parseInt(req.params.id);
    const projectItems = await query(
      `SELECT id, description AS item_name, qty AS quantity,
              price AS unit_price, ext_price AS total,
              qb_item_name,
              'project'::text AS source
         FROM items
        WHERE project_id = $1
        ORDER BY id`,
      [projectId]
    );
    // Online-order line items: format the display name as
    // "<product>  (<color>, <size>)" so staff can read it like a manual row.
    const orderItems = await query(
      `SELECT oi.id,
              CONCAT(
                oi.product_name,
                ' (', oi.color_name,
                CASE WHEN COALESCE(oi.size, '') <> '' THEN ', ' || oi.size ELSE '' END,
                ')'
              ) AS item_name,
              oi.quantity::numeric AS quantity,
              oi.unit_price        AS unit_price,
              oi.line_subtotal     AS total,
              NULL                 AS qb_item_name,
              'order'::text        AS source
         FROM order_items oi
         JOIN orders     o ON o.id = oi.order_id
        WHERE o.job_id = $1
        ORDER BY oi.id`,
      [projectId]
    );
    res.json([...projectItems, ...orderItems]);
  } catch (e) {
    res.status(500).json({ message: 'Failed to load items', detail: e.message });
  }
});

// ─── POST /api/projects/:id/items ────────────────────────────────────────────
router.post('/:id/items', requireStaff, async (req, res) => {
  const { description, qty, price, total, qb_item_name } = req.body;
  if (!description?.trim()) return res.status(400).json({ message: 'Description required' });
  try {
    await query(
      `INSERT INTO items (project_id, description, qty, price, ext_price, qb_item_name)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [
        parseInt(req.params.id),
        description.trim(),
        parseFloat(qty) || 1,
        parseFloat(price) || 0,
        parseFloat(total) || 0,
        qb_item_name || null,
      ]
    );
    res.status(201).json({ message: 'Item added' });
  } catch (e) {
    res.status(500).json({ message: 'Failed to add item', detail: e.message });
  }
});

// ─── PUT /api/projects/:id/items/:itemId ─────────────────────────────────────
router.put('/:id/items/:itemId', requireStaff, async (req, res) => {
  const { description, qty, price, total, qb_item_name } = req.body;
  if (!description?.trim()) return res.status(400).json({ message: 'Description required' });
  try {
    const rows = await query(
      `UPDATE items
          SET description  = $1,
              qty          = $2,
              price        = $3,
              ext_price    = $4,
              qb_item_name = $5
        WHERE id = $6 AND project_id = $7
        RETURNING id`,
      [
        description.trim(),
        parseFloat(qty) || 1,
        parseFloat(price) || 0,
        parseFloat(total) || 0,
        qb_item_name || null,
        parseInt(req.params.itemId),
        parseInt(req.params.id),
      ]
    );
    if (rows.length === 0) return res.status(404).json({ message: 'Item not found' });
    res.json({ message: 'Item updated' });
  } catch (e) {
    res.status(500).json({ message: 'Failed to update item', detail: e.message });
  }
});

// ─── DELETE /api/projects/:id/items/:itemId ──────────────────────────────────
router.delete('/:id/items/:itemId', requireStaff, async (req, res) => {
  try {
    const rows = await query(
      `DELETE FROM items
        WHERE id = $1 AND project_id = $2
        RETURNING id`,
      [parseInt(req.params.itemId), parseInt(req.params.id)]
    );
    if (rows.length === 0) return res.status(404).json({ message: 'Item not found' });
    res.json({ message: 'Item deleted' });
  } catch (e) {
    res.status(500).json({ message: 'Failed to delete item', detail: e.message });
  }
});

// Treat empty strings, null, undefined, and unparseable values as NULL. The
// previous POST handler used `parseFloat(width)` directly, which returns NaN
// for an empty input. That NaN was being written to PG's NUMERIC column and
// later rendered as the literal string "NaN" in the UI.
function toFiniteNumber(v) {
  if (v === null || v === undefined || v === '') return null;
  const n = parseFloat(v);
  return Number.isFinite(n) ? n : null;
}

// ─── POST /api/projects/:id/measurements ─────────────────────────────────────
router.post('/:id/measurements', requireStaff, async (req, res) => {
  const { item, width, height, notes } = req.body;
  try {
    const rows = await query(
      `INSERT INTO measurements (project_id, item, width_in, height_in, comment)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING id, item, width_in AS width, height_in AS height, comment AS notes`,
      [
        parseInt(req.params.id),
        item || null,
        toFiniteNumber(width),
        toFiniteNumber(height),
        notes || null,
      ]
    );
    res.status(201).json({ message: 'Measurement added', measurement: rows[0] });
  } catch (e) {
    res.status(500).json({ message: 'Failed to add measurement', detail: e.message });
  }
});

// ─── PUT /api/projects/:id/measurements/:mId ─────────────────────────────────
router.put('/:id/measurements/:mId', requireStaff, async (req, res) => {
  const { item, width, height, notes } = req.body;
  try {
    const rows = await query(
      `UPDATE measurements
          SET item      = $1,
              width_in  = $2,
              height_in = $3,
              comment   = $4
        WHERE id = $5 AND project_id = $6
        RETURNING id, item, width_in AS width, height_in AS height, comment AS notes`,
      [
        item || null,
        toFiniteNumber(width),
        toFiniteNumber(height),
        notes || null,
        parseInt(req.params.mId),
        parseInt(req.params.id),
      ]
    );
    if (rows.length === 0) return res.status(404).json({ message: 'Measurement not found' });
    res.json({ message: 'Measurement updated', measurement: rows[0] });
  } catch (e) {
    res.status(500).json({ message: 'Failed to update measurement', detail: e.message });
  }
});

// ─── DELETE /api/projects/:id/measurements/:mId ──────────────────────────────
router.delete('/:id/measurements/:mId', requireStaff, async (req, res) => {
  try {
    const rows = await query(
      `DELETE FROM measurements
        WHERE id = $1 AND project_id = $2
        RETURNING id`,
      [parseInt(req.params.mId), parseInt(req.params.id)]
    );
    if (rows.length === 0) return res.status(404).json({ message: 'Measurement not found' });
    res.json({ message: 'Measurement deleted' });
  } catch (e) {
    res.status(500).json({ message: 'Failed to delete measurement', detail: e.message });
  }
});

// ─── GET /api/projects/:id/photos ────────────────────────────────────────────
// Returns every photo on this job. Metadata (category, show_in_gallery)
// comes from the project_photos table; the raw file lives on WHC.
router.get('/:id/photos', requireAuth, async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!Number.isInteger(id)) {
    return res.status(400).json({ message: 'Invalid project id' });
  }
  try {
    const rows = await query(
      `SELECT id,
              filename,
              category,
              show_in_gallery,
              uploaded_at,
              uploaded_by
         FROM project_photos
        WHERE project_id = $1
        ORDER BY uploaded_at DESC, id DESC`,
      [id]
    );
    const out = rows.map((r) => ({
      id:              r.id,
      filename:        r.filename,
      category:        r.category,
      show_in_gallery: r.show_in_gallery,
      uploaded:        r.uploaded_at,
      uploaded_by:     r.uploaded_by,
      url:             `${WHC_PUBLIC_BASE}/${id}/${encodeURIComponent(r.filename)}`,
    }));
    res.json(out);
  } catch (e) {
    console.error('GET /:id/photos:', e);
    res.status(500).json({ message: 'Failed to load photos', detail: e.message });
  }
});

// ─── POST /api/projects/:id/photos ───────────────────────────────────────────
// Uploads one or more files. `category` comes in as a form field alongside
// the files — same value applies to every file in this request.
// Writes to WHC via FTPS, then inserts metadata rows.
router.post('/:id/photos', requireStaff, upload.array('photos', 20), async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!Number.isInteger(id)) {
    return res.status(400).json({ message: 'Invalid project id' });
  }
  if (!req.files || req.files.length === 0) {
    return res.status(400).json({ message: 'No files uploaded' });
  }
  const category = normalizeCategory(req.body.category);
  const remoteDir = `${WHC_REMOTE_BASE}/${id}`;
  let client;
  try {
    client = await connectFtp(30000);
    await client.ensureDir(remoteDir);
    const uploaded = [];
    for (const f of req.files) {
      const ext = path.extname(f.originalname).toLowerCase() || '.jpg';
      const safeName = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}${ext}`;
      await client.uploadFrom(Readable.from(f.buffer), safeName);
      const inserted = await queryOne(
        `INSERT INTO project_photos (project_id, filename, category, uploaded_by)
         VALUES ($1, $2, $3, $4)
         RETURNING id, uploaded_at`,
        [id, safeName, category, req.user?.id || null]
      );
      uploaded.push({
        id:              inserted.id,
        filename:        safeName,
        category,
        show_in_gallery: false,
        uploaded:        inserted.uploaded_at,
        url:             `${WHC_PUBLIC_BASE}/${id}/${encodeURIComponent(safeName)}`,
      });
    }
    res.status(201).json({ message: `${uploaded.length} photo(s) uploaded`, files: uploaded });
  } catch (e) {
    console.error('POST /:id/photos:', e);
    res.status(500).json({ message: 'Failed to upload photos', detail: e.message });
  } finally {
    if (client) client.close();
  }
});

// ─── PATCH /api/projects/:id/photos/:photoId ─────────────────────────────────
// Admin curation: flip show_in_gallery and/or change category. Both fields
// are optional; whichever are present in the body get updated.
router.patch('/:id/photos/:photoId', requireAdmin, async (req, res) => {
  const id      = parseInt(req.params.id, 10);
  const photoId = parseInt(req.params.photoId, 10);
  if (!Number.isInteger(id) || !Number.isInteger(photoId)) {
    return res.status(400).json({ message: 'Invalid id(s)' });
  }

  const sets = [];
  const params = [];
  if (typeof req.body.show_in_gallery === 'boolean') {
    params.push(req.body.show_in_gallery);
    sets.push(`show_in_gallery = $${params.length}`);
  }
  if (req.body.category !== undefined) {
    params.push(normalizeCategory(req.body.category));
    sets.push(`category = $${params.length}`);
  }
  if (sets.length === 0) {
    return res.status(400).json({ message: 'Nothing to update' });
  }
  params.push(photoId, id);
  try {
    const updated = await queryOne(
      `UPDATE project_photos
          SET ${sets.join(', ')}
        WHERE id = $${params.length - 1} AND project_id = $${params.length}
        RETURNING id, filename, category, show_in_gallery, uploaded_at`,
      params
    );
    if (!updated) return res.status(404).json({ message: 'Photo not found' });
    res.json(updated);
  } catch (e) {
    console.error('PATCH /:id/photos/:photoId:', e);
    res.status(500).json({ message: 'Failed to update photo', detail: e.message });
  }
});

// ─── DELETE /api/projects/:id/photos/:target ─────────────────────────────────
// Deletes the DB row and the file on WHC. Idempotent on the FTP side.
// `:target` may be either a numeric project_photos.id (preferred) or a
// filename (legacy — the pre-DB frontend uses filename). Handling both
// lets us deploy the API without coordinating a frontend deploy.
router.delete('/:id/photos/:target', requireStaff, async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!Number.isInteger(id)) {
    return res.status(400).json({ message: 'Invalid project id' });
  }
  const target = req.params.target;

  let row;
  if (/^\d+$/.test(target)) {
    row = await queryOne(
      `SELECT id, filename FROM project_photos WHERE id = $1 AND project_id = $2`,
      [parseInt(target, 10), id]
    );
  } else {
    // Legacy path: lookup by filename within this project.
    const safe = target.replace(/[\/\\]/g, '');
    row = await queryOne(
      `SELECT id, filename FROM project_photos WHERE project_id = $1 AND filename = $2`,
      [id, safe]
    );
  }
  if (!row) return res.status(404).json({ message: 'Photo not found' });

  const filename   = row.filename.replace(/[\/\\]/g, '');
  const remotePath = `${WHC_REMOTE_BASE}/${id}/${filename}`;

  let client;
  try {
    client = await connectFtp();
    try { await client.remove(remotePath); }
    catch (e) { /* already gone — ignore */ }
    await query(`DELETE FROM project_photos WHERE id = $1`, [row.id]);
    res.json({ message: 'Photo deleted' });
  } catch (e) {
    console.error('DELETE /:id/photos/:target:', e);
    res.status(500).json({ message: 'Failed to delete photo', detail: e.message });
  } finally {
    if (client) client.close();
  }
});

// ─── POST /api/projects/admin/backfill-photos ────────────────────────────────
// One-shot. Walks WHC folders and inserts project_photos rows for every
// file already on disk. Re-runnable (unique constraint makes it idempotent).
// Runs synchronously — may take a while with 565 MB of photos; bump
// client-side timeout if you invoke this from a browser.
router.post('/admin/backfill-photos', requireAdmin, async (req, res) => {
  try {
    const logs = [];
    const stats = await runBackfill({ log: (m) => logs.push(m) });
    res.json({ ...stats, logs });
  } catch (e) {
    console.error('backfill:', e);
    res.status(500).json({ message: 'Backfill failed', detail: e.message });
  }
});

module.exports = router;
