// routes/clients.js
// Client-level endpoints. Currently just the manual folder-override for the
// files-bridge (powers the "Change folder" button on the job detail screen).
//
// The files-bridge auto-resolves NAS folders from the derived client name
// (COALESCE(c.company, c.fname || c.lname)). That fails for ~49% of clients
// because staff created folders in 'Last First' or unusual formats. Rather
// than chasing every DB row, we let staff pick the right folder on the fly;
// the pick lives on clients.files_folder and the shop API returns it as
// client_folder_name on /api/projects responses.

const express = require('express');
const { query, queryOne } = require('../db/connection');
const { requireAuth, requireStaff } = require('../middleware/auth');

const router = express.Router();

// ─── GET /api/clients/folder-mappings ────────────────────────────────────────
// Returns every client's id, name, override value, and the effective folder
// name (override if set, derived otherwise).
//
// Used by the folder-picker modal to annotate "already used by X" so staff
// don't accidentally point two clients at the same folder. Cheap to fetch —
// a few KB of text, cached per modal-open.
//
// Any logged-in user can call this; it's just names, no sensitive data.
router.get('/folder-mappings', requireAuth, async (req, res) => {
  try {
    const rows = await query(
      `SELECT id,
              COALESCE(company, CONCAT_WS(' ', fname, lname)) AS client_name,
              files_folder,
              COALESCE(NULLIF(files_folder, ''),
                       company,
                       CONCAT_WS(' ', fname, lname)) AS effective_folder
         FROM clients
        ORDER BY id`
    );
    res.json(rows);
  } catch (e) {
    console.error('GET /clients/folder-mappings:', e);
    res.status(500).json({ message: 'Failed to load folder mappings', detail: e.message });
  }
});

// ─── PATCH /api/clients/:id/folder ───────────────────────────────────────────
// Set (or clear) a client's files_folder override.
//
// Body: { folder: "Batte Adam" }   — set the override
//       { folder: null }           — clear the override (revert to auto-derive)
//       { folder: "" }             — same as null
//
// Staff-only. Returns the updated client row (id + effective_folder).
router.patch('/:id/folder', requireStaff, async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!Number.isInteger(id)) {
    return res.status(400).json({ message: 'Invalid client id' });
  }

  // Normalize: treat null, undefined, empty string, and whitespace as "clear".
  let folder = req.body?.folder;
  if (folder === undefined || folder === null) {
    folder = null;
  } else if (typeof folder === 'string') {
    folder = folder.trim();
    if (folder === '') folder = null;
  } else {
    return res.status(400).json({ message: 'folder must be a string or null' });
  }

  // Light validation on the override value — same character set the bridge
  // accepts on POST /folders so we can't save something the bridge then
  // refuses to create or resolve.
  if (folder !== null && !/^[A-Za-z0-9 _.\-&',()]+$/.test(folder)) {
    return res.status(400).json({ message: 'folder name contains unsupported characters' });
  }
  if (folder !== null && folder.length > 255) {
    return res.status(400).json({ message: 'folder name too long' });
  }

  try {
    const updated = await queryOne(
      `UPDATE clients
          SET files_folder = $1
        WHERE id = $2
        RETURNING id,
                  COALESCE(company, CONCAT_WS(' ', fname, lname)) AS client_name,
                  files_folder,
                  COALESCE(NULLIF(files_folder, ''),
                           company,
                           CONCAT_WS(' ', fname, lname)) AS effective_folder`,
      [folder, id]
    );
    if (!updated) return res.status(404).json({ message: 'Client not found' });
    res.json(updated);
  } catch (e) {
    console.error('PATCH /clients/:id/folder:', e);
    res.status(500).json({ message: 'Failed to update folder', detail: e.message });
  }
});

// ─── GET /api/clients/:id/led-signs ──────────────────────────────────────────
// Every LED sign belonging to a client, each with its service history
// nested in a `service_history` array (most-recent first).
//
// Used by the "LED Signs" tab on the job detail screen so field techs
// can look up specs (pitch, dimensions, power, cellular number, etc.)
// without leaving the job they're working on.
//
// We DO NOT return the wifi_password_enc / cloud_password_enc columns.
// They're stored encrypted-at-rest and we have no decryption key wired
// up here — returning ciphertext would be noise at best, a leak at worst.
// When the decrypt flow lands, add them back behind a requireAdmin guard.
router.get('/:id/led-signs', requireAuth, async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!Number.isInteger(id)) {
    return res.status(400).json({ message: 'Invalid client id' });
  }
  try {
    const rows = await query(
      `SELECT s.id, s.project_id, s.client_id, s.sign_name, s.location,
              s.control_system, s.pitch, s.width_mm, s.height_mm,
              s.serial_number, s.inventory_no, s.module_size,
              s.power_supply, s.esa_no, s.faces, s.cabinets,
              s.install_date, s.voltage, s.total_amp,
              s.wifi_ssid, s.cloud_username, s.cellular_number,
              COALESCE(
                (SELECT json_agg(sh ORDER BY sh.service_date DESC NULLS LAST, sh.id DESC)
                   FROM (
                     SELECT ls.id, ls.service_date, ls.issue, ls.solution,
                            ls.serviced_by,
                            NULLIF(TRIM(CONCAT_WS(' ', e.first_name, e.last_name)), '') AS serviced_by_name,
                            ls.created_at
                       FROM led_service ls
                       LEFT JOIN employees e ON e.id = ls.serviced_by
                      WHERE ls.led_sign_id = s.id
                   ) sh),
                '[]'::json
              ) AS service_history
         FROM led_signs s
        WHERE s.client_id = $1
        ORDER BY s.sign_name NULLS LAST, s.id`,
      [id]
    );
    res.json(rows);
  } catch (e) {
    console.error('GET /clients/:id/led-signs:', e);
    res.status(500).json({ message: 'Failed to load LED signs', detail: e.message });
  }
});

// ─── GET /api/clients/:id/modules ────────────────────────────────────────────
// Every modules-inventory row linked to one of this client's LED signs,
// each with the list of signs that share it nested as `signs`.
//
// Why the join through led_signs (not modules.client_id): the modules
// table is flat inventory with no client column. A module belongs to a
// client only because one of that client's signs points at it
// (led_signs.module_id). Most signs have a unique module; occasionally
// multiple signs share one row (ordered together), which is why `signs`
// is an array.
//
// on_hand comes back NULL when we've never counted — the UI renders it as
// "—" rather than "0" so staff don't mistake "unknown" for "empty".
router.get('/:id/modules', requireAuth, async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!Number.isInteger(id)) {
    return res.status(400).json({ message: 'Invalid client id' });
  }
  try {
    const rows = await query(
      `SELECT m.id,
              m.module_id_no,
              m.starting_inventory,
              m.on_hand,
              m.created_at,
              m.updated_at,
              COALESCE(
                (SELECT json_agg(json_build_object(
                          'id',        s.id,
                          'sign_name', s.sign_name,
                          'location',  s.location
                        ) ORDER BY s.sign_name NULLS LAST, s.id)
                   FROM led_signs s
                  WHERE s.client_id = $1
                    AND s.module_id = m.id),
                '[]'::json
              ) AS signs
         FROM modules m
        WHERE EXISTS (
                SELECT 1 FROM led_signs s2
                 WHERE s2.client_id = $1
                   AND s2.module_id = m.id
              )
        ORDER BY m.module_id_no NULLS LAST, m.id`,
      [id]
    );
    res.json(rows);
  } catch (e) {
    console.error('GET /clients/:id/modules:', e);
    res.status(500).json({ message: 'Failed to load modules', detail: e.message });
  }
});

// ─── GET /api/clients/:id/wifi ───────────────────────────────────────────────
// WiFi credentials for a client's site(s). Plain-text in the table today —
// any logged-in staff can read them (same as the files-bridge pattern).
router.get('/:id/wifi', requireAuth, async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!Number.isInteger(id)) {
    return res.status(400).json({ message: 'Invalid client id' });
  }
  try {
    const rows = await query(
      `SELECT id, client_id, location, ssid, password, created_at, updated_at
         FROM client_wifi
        WHERE client_id = $1
        ORDER BY location NULLS LAST, id`,
      [id]
    );
    res.json(rows);
  } catch (e) {
    console.error('GET /clients/:id/wifi:', e);
    res.status(500).json({ message: 'Failed to load WiFi entries', detail: e.message });
  }
});

// ═════════════════════════════════════════════════════════════════════════════
// LED SIGNS — CRUD + service log
// ═════════════════════════════════════════════════════════════════════════════
//
// GET /clients/:id/led-signs already exists above. Below are writes.
//
// All writes require staff. LED sign records are deliberately thin on
// validation — the set of columns (pitch, voltage, SSID, cellular, etc.)
// is wide and staff need to be able to correct weird historical values.
// We coerce empty strings to NULL so the DB shows "—" instead of "" and
// quietly skip fields the client didn't send.

// Whitelist of columns the UI is allowed to write. Anything not in here
// is silently dropped, so a client can send the full row object from the
// GET and we'll just pick off the valid fields. Keeps the PUT handler a
// one-liner and avoids SQL-injection on column names.
const LED_SIGN_WRITABLE = [
  'sign_name', 'location',
  'control_system', 'pitch',
  'width_mm', 'height_mm',
  'serial_number', 'inventory_no', 'module_size',
  'power_supply', 'esa_no',
  'faces', 'cabinets',
  'install_date', 'voltage', 'total_amp',
  'wifi_ssid', 'cloud_username', 'cellular_number',
  'module_id',
];

// Normalise a raw body value for storage:
//   - strings:  trim, empty → null
//   - null/undefined → null
//   - numbers: passed through (caller is responsible for column type)
function cleanValue(v) {
  if (v === undefined || v === null) return null;
  if (typeof v === 'string') {
    const t = v.trim();
    return t === '' ? null : t;
  }
  return v;
}

// Build a { cols, vals, placeholders } tuple from the request body for
// INSERT/UPDATE. Only keys in `whitelist` are included.
function extractFields(body, whitelist) {
  const cols = [];
  const vals = [];
  for (const k of whitelist) {
    if (k in body) {
      cols.push(k);
      vals.push(cleanValue(body[k]));
    }
  }
  return { cols, vals };
}

// ─── POST /api/clients/:id/led-signs ─────────────────────────────────────────
// Add a new LED sign for this client. Minimum required is sign_name; every
// other spec can be filled in later.
router.post('/:id/led-signs', requireStaff, async (req, res) => {
  const clientId = parseInt(req.params.id, 10);
  if (!Number.isInteger(clientId)) {
    return res.status(400).json({ message: 'Invalid client id' });
  }
  if (!req.body?.sign_name || !String(req.body.sign_name).trim()) {
    return res.status(400).json({ message: 'sign_name is required' });
  }
  try {
    const { cols, vals } = extractFields(req.body, LED_SIGN_WRITABLE);
    // Always-set columns.
    cols.unshift('client_id');
    vals.unshift(clientId);

    const placeholders = vals.map((_, i) => `$${i + 1}`).join(', ');
    const created = await queryOne(
      `INSERT INTO led_signs (${cols.join(', ')})
       VALUES (${placeholders})
       RETURNING *`,
      vals
    );
    res.status(201).json(created);
  } catch (e) {
    console.error('POST /clients/:id/led-signs:', e);
    res.status(500).json({ message: 'Failed to create LED sign', detail: e.message });
  }
});

// ─── PUT /api/led-signs/:id ──────────────────────────────────────────────────
// Update any subset of the whitelisted spec fields. Does NOT allow moving
// a sign between clients — that's deliberate. If a sign was entered under
// the wrong client, delete + recreate is safer than silently reparenting.
router.put('/led-signs/:id', requireStaff, async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!Number.isInteger(id)) {
    return res.status(400).json({ message: 'Invalid sign id' });
  }
  const { cols, vals } = extractFields(req.body, LED_SIGN_WRITABLE);
  if (cols.length === 0) {
    return res.status(400).json({ message: 'No writable fields provided' });
  }
  try {
    const setClause = cols.map((c, i) => `${c} = $${i + 1}`).join(', ');
    vals.push(id);
    const updated = await queryOne(
      `UPDATE led_signs
          SET ${setClause}
        WHERE id = $${vals.length}
        RETURNING *`,
      vals
    );
    if (!updated) return res.status(404).json({ message: 'LED sign not found' });
    res.json(updated);
  } catch (e) {
    console.error('PUT /led-signs/:id:', e);
    res.status(500).json({ message: 'Failed to update LED sign', detail: e.message });
  }
});

// ─── DELETE /api/led-signs/:id ───────────────────────────────────────────────
// Nukes the sign AND its service_history (led_service FK should cascade;
// if the DB isn't set up to cascade, delete children first).
router.delete('/led-signs/:id', requireStaff, async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!Number.isInteger(id)) {
    return res.status(400).json({ message: 'Invalid sign id' });
  }
  try {
    // Belt-and-suspenders: delete service history first in case FK isn't cascaded.
    await query(`DELETE FROM led_service WHERE led_sign_id = $1`, [id]);
    const deleted = await queryOne(
      `DELETE FROM led_signs WHERE id = $1 RETURNING id`,
      [id]
    );
    if (!deleted) return res.status(404).json({ message: 'LED sign not found' });
    res.json({ message: 'Deleted', id: deleted.id });
  } catch (e) {
    console.error('DELETE /led-signs/:id:', e);
    res.status(500).json({ message: 'Failed to delete LED sign', detail: e.message });
  }
});

// ─── POST /api/led-signs/:id/service ─────────────────────────────────────────
// Log a service call against a sign. serviced_by is the employee id of the
// person who did the work (free-form from the UI dropdown). service_date
// defaults to today if the UI didn't pass one.
router.post('/led-signs/:id/service', requireStaff, async (req, res) => {
  const signId = parseInt(req.params.id, 10);
  if (!Number.isInteger(signId)) {
    return res.status(400).json({ message: 'Invalid sign id' });
  }
  const issue       = cleanValue(req.body?.issue);
  const solution    = cleanValue(req.body?.solution);
  const servicedBy  = req.body?.serviced_by ? parseInt(req.body.serviced_by, 10) : null;
  const serviceDate = cleanValue(req.body?.service_date); // ISO date string or null → today

  if (!issue && !solution) {
    return res.status(400).json({ message: 'issue or solution is required' });
  }
  try {
    const created = await queryOne(
      `INSERT INTO led_service
         (led_sign_id, service_date, issue, solution, serviced_by)
       VALUES ($1, COALESCE($2::date, CURRENT_DATE), $3, $4, $5)
       RETURNING *`,
      [signId, serviceDate, issue, solution, servicedBy]
    );
    res.status(201).json(created);
  } catch (e) {
    console.error('POST /led-signs/:id/service:', e);
    res.status(500).json({ message: 'Failed to log service call', detail: e.message });
  }
});

// ─── PUT /api/led-service/:id ────────────────────────────────────────────────
// Edit a previously-logged service record. Same field set as POST.
router.put('/led-service/:id', requireStaff, async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!Number.isInteger(id)) {
    return res.status(400).json({ message: 'Invalid service id' });
  }
  const issue       = cleanValue(req.body?.issue);
  const solution    = cleanValue(req.body?.solution);
  const servicedBy  = req.body?.serviced_by ? parseInt(req.body.serviced_by, 10) : null;
  const serviceDate = cleanValue(req.body?.service_date);
  try {
    const updated = await queryOne(
      `UPDATE led_service
          SET service_date = COALESCE($1::date, service_date),
              issue        = $2,
              solution     = $3,
              serviced_by  = $4
        WHERE id = $5
        RETURNING *`,
      [serviceDate, issue, solution, servicedBy, id]
    );
    if (!updated) return res.status(404).json({ message: 'Service record not found' });
    res.json(updated);
  } catch (e) {
    console.error('PUT /led-service/:id:', e);
    res.status(500).json({ message: 'Failed to update service record', detail: e.message });
  }
});

// ─── DELETE /api/led-service/:id ─────────────────────────────────────────────
router.delete('/led-service/:id', requireStaff, async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!Number.isInteger(id)) {
    return res.status(400).json({ message: 'Invalid service id' });
  }
  try {
    const deleted = await queryOne(
      `DELETE FROM led_service WHERE id = $1 RETURNING id`,
      [id]
    );
    if (!deleted) return res.status(404).json({ message: 'Service record not found' });
    res.json({ message: 'Deleted', id: deleted.id });
  } catch (e) {
    console.error('DELETE /led-service/:id:', e);
    res.status(500).json({ message: 'Failed to delete service record', detail: e.message });
  }
});

// ═════════════════════════════════════════════════════════════════════════════
// WIFI — CRUD
// ═════════════════════════════════════════════════════════════════════════════
//
// client_wifi is a flat table: id, client_id, location, ssid, password.
// Passwords stored plain — same security posture as the files-bridge. When
// encryption at rest lands, swap the read/write here.

// ─── POST /api/clients/:id/wifi ──────────────────────────────────────────────
router.post('/:id/wifi', requireStaff, async (req, res) => {
  const clientId = parseInt(req.params.id, 10);
  if (!Number.isInteger(clientId)) {
    return res.status(400).json({ message: 'Invalid client id' });
  }
  const location = cleanValue(req.body?.location);
  const ssid     = cleanValue(req.body?.ssid);
  const password = cleanValue(req.body?.password);
  if (!ssid && !location) {
    return res.status(400).json({ message: 'location or ssid is required' });
  }
  try {
    const created = await queryOne(
      `INSERT INTO client_wifi (client_id, location, ssid, password)
       VALUES ($1, $2, $3, $4)
       RETURNING *`,
      [clientId, location, ssid, password]
    );
    res.status(201).json(created);
  } catch (e) {
    console.error('POST /clients/:id/wifi:', e);
    res.status(500).json({ message: 'Failed to create WiFi entry', detail: e.message });
  }
});

// ─── PUT /api/wifi/:id ───────────────────────────────────────────────────────
router.put('/wifi/:id', requireStaff, async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!Number.isInteger(id)) {
    return res.status(400).json({ message: 'Invalid wifi id' });
  }
  const location = cleanValue(req.body?.location);
  const ssid     = cleanValue(req.body?.ssid);
  const password = cleanValue(req.body?.password);
  try {
    const updated = await queryOne(
      `UPDATE client_wifi
          SET location = $1, ssid = $2, password = $3, updated_at = NOW()
        WHERE id = $4
        RETURNING *`,
      [location, ssid, password, id]
    );
    if (!updated) return res.status(404).json({ message: 'WiFi entry not found' });
    res.json(updated);
  } catch (e) {
    console.error('PUT /wifi/:id:', e);
    res.status(500).json({ message: 'Failed to update WiFi entry', detail: e.message });
  }
});

// ─── DELETE /api/wifi/:id ────────────────────────────────────────────────────
router.delete('/wifi/:id', requireStaff, async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!Number.isInteger(id)) {
    return res.status(400).json({ message: 'Invalid wifi id' });
  }
  try {
    const deleted = await queryOne(
      `DELETE FROM client_wifi WHERE id = $1 RETURNING id`,
      [id]
    );
    if (!deleted) return res.status(404).json({ message: 'WiFi entry not found' });
    res.json({ message: 'Deleted', id: deleted.id });
  } catch (e) {
    console.error('DELETE /wifi/:id:', e);
    res.status(500).json({ message: 'Failed to delete WiFi entry', detail: e.message });
  }
});

// ═════════════════════════════════════════════════════════════════════════════
// MODULES — CRUD + sign linker
// ═════════════════════════════════════════════════════════════════════════════
//
// modules is a flat inventory table with no client_id. A module "belongs"
// to a client only via led_signs.module_id. That means:
//   - Creating / listing all modules happens at the top-level /modules.
//   - The "Used by" link is managed on led_signs, not modules.
// The existing GET /clients/:id/modules (above) joins the two to produce
// the per-client view shown on the Modules tab.

const MODULE_WRITABLE = ['module_id_no', 'starting_inventory', 'on_hand'];

// ─── GET /api/modules ────────────────────────────────────────────────────────
// Full inventory list — used by the sign→module picker on the LED Signs
// tab so staff can choose which module a sign uses.
router.get('/modules/all', requireAuth, async (req, res) => {
  try {
    const rows = await query(
      `SELECT id, module_id_no, starting_inventory, on_hand, created_at, updated_at
         FROM modules
        ORDER BY module_id_no NULLS LAST, id`
    );
    res.json(rows);
  } catch (e) {
    console.error('GET /modules/all:', e);
    res.status(500).json({ message: 'Failed to load modules', detail: e.message });
  }
});

// ─── POST /api/modules ───────────────────────────────────────────────────────
router.post('/modules', requireStaff, async (req, res) => {
  const moduleIdNo = cleanValue(req.body?.module_id_no);
  if (!moduleIdNo) {
    return res.status(400).json({ message: 'module_id_no is required' });
  }
  const { cols, vals } = extractFields(req.body, MODULE_WRITABLE);
  try {
    const placeholders = vals.map((_, i) => `$${i + 1}`).join(', ');
    const created = await queryOne(
      `INSERT INTO modules (${cols.join(', ')})
       VALUES (${placeholders})
       RETURNING *`,
      vals
    );
    res.status(201).json(created);
  } catch (e) {
    console.error('POST /modules:', e);
    res.status(500).json({ message: 'Failed to create module', detail: e.message });
  }
});

// ─── PUT /api/modules/:id ────────────────────────────────────────────────────
router.put('/modules/:id', requireStaff, async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!Number.isInteger(id)) {
    return res.status(400).json({ message: 'Invalid module id' });
  }
  const { cols, vals } = extractFields(req.body, MODULE_WRITABLE);
  if (cols.length === 0) {
    return res.status(400).json({ message: 'No writable fields provided' });
  }
  try {
    const setClause = cols.map((c, i) => `${c} = $${i + 1}`).join(', ');
    vals.push(id);
    const updated = await queryOne(
      `UPDATE modules
          SET ${setClause}, updated_at = NOW()
        WHERE id = $${vals.length}
        RETURNING *`,
      vals
    );
    if (!updated) return res.status(404).json({ message: 'Module not found' });
    res.json(updated);
  } catch (e) {
    console.error('PUT /modules/:id:', e);
    res.status(500).json({ message: 'Failed to update module', detail: e.message });
  }
});

// ─── DELETE /api/modules/:id ─────────────────────────────────────────────────
// ON DELETE SET NULL on led_signs.module_id handles the orphaned links —
// the signs themselves are preserved, they just become unlinked.
router.delete('/modules/:id', requireStaff, async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!Number.isInteger(id)) {
    return res.status(400).json({ message: 'Invalid module id' });
  }
  try {
    const deleted = await queryOne(
      `DELETE FROM modules WHERE id = $1 RETURNING id`,
      [id]
    );
    if (!deleted) return res.status(404).json({ message: 'Module not found' });
    res.json({ message: 'Deleted', id: deleted.id });
  } catch (e) {
    console.error('DELETE /modules/:id:', e);
    res.status(500).json({ message: 'Failed to delete module', detail: e.message });
  }
});

// ─── PATCH /api/led-signs/:id/module ─────────────────────────────────────────
// Link a sign to a module inventory row (or unlink).
//   { module_id: 42 }   → link
//   { module_id: null } → unlink
router.patch('/led-signs/:id/module', requireStaff, async (req, res) => {
  const signId = parseInt(req.params.id, 10);
  if (!Number.isInteger(signId)) {
    return res.status(400).json({ message: 'Invalid sign id' });
  }
  let moduleId = req.body?.module_id;
  if (moduleId === undefined || moduleId === null || moduleId === '') {
    moduleId = null;
  } else {
    moduleId = parseInt(moduleId, 10);
    if (!Number.isInteger(moduleId)) {
      return res.status(400).json({ message: 'module_id must be an integer or null' });
    }
  }
  try {
    const updated = await queryOne(
      `UPDATE led_signs
          SET module_id = $1
        WHERE id = $2
        RETURNING id, sign_name, client_id, module_id`,
      [moduleId, signId]
    );
    if (!updated) return res.status(404).json({ message: 'LED sign not found' });
    res.json(updated);
  } catch (e) {
    console.error('PATCH /led-signs/:id/module:', e);
    res.status(500).json({ message: 'Failed to update link', detail: e.message });
  }
});

// ═════════════════════════════════════════════════════════════════════════════
// CLIENT CORE — update main client row + addresses + phones
// ═════════════════════════════════════════════════════════════════════════════
//
// The clients router was originally just the folder-override mapping; the
// list/get/create endpoints live in lookup.js for historical reasons. We
// keep the edit surface here because it's grown into the client-scoped
// namespace (LED signs, WiFi, modules) and this is where future work lands.

const CLIENT_WRITABLE  = ['company', 'fname', 'lname', 'email'];
const ADDRESS_WRITABLE = ['address1', 'address2', 'town', 'province', 'postal_code', 'address_type'];
const PHONE_WRITABLE   = ['number', 'ext', 'phone_type'];

// ─── PUT /api/clients/:id ────────────────────────────────────────────────────
// Update company / first name / last name / email. At least one of company
// or last name must remain populated after the update (matches the POST
// guard in lookup.js).
router.put('/:id', requireStaff, async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!Number.isInteger(id)) return res.status(400).json({ message: 'Invalid client id' });

  const { cols, vals } = extractFields(req.body, CLIENT_WRITABLE);
  if (cols.length === 0) return res.status(400).json({ message: 'No updatable fields provided' });

  // Guard against blanking out both company and last name at once. We read
  // the existing row and merge — the UI may only send the field it changed.
  const current = await queryOne('SELECT company, lname FROM clients WHERE id = $1', [id]);
  if (!current) return res.status(404).json({ message: 'Client not found' });
  const effCompany = cols.includes('company') ? vals[cols.indexOf('company')] : current.company;
  const effLname   = cols.includes('lname')   ? vals[cols.indexOf('lname')]   : current.lname;
  if (!effCompany && !effLname) {
    return res.status(400).json({ message: 'Company or last name is required' });
  }

  try {
    const set = cols.map((c, i) => `${c} = $${i + 1}`).join(', ');
    const updated = await queryOne(
      `UPDATE clients SET ${set} WHERE id = $${cols.length + 1}
       RETURNING id,
                 company AS company_name,
                 fname   AS first_name,
                 lname   AS last_name,
                 email`,
      [...vals, id]
    );
    res.json(updated);
  } catch (e) {
    console.error('PUT /clients/:id:', e);
    res.status(500).json({ message: 'Failed to update client', detail: e.message });
  }
});

// ─── POST /api/clients/:id/addresses ─────────────────────────────────────────
router.post('/:id/addresses', requireStaff, async (req, res) => {
  const clientId = parseInt(req.params.id, 10);
  if (!Number.isInteger(clientId)) return res.status(400).json({ message: 'Invalid client id' });
  try {
    const { cols, vals } = extractFields(req.body, ADDRESS_WRITABLE);
    cols.unshift('client_id');
    vals.unshift(clientId);
    const placeholders = cols.map((_, i) => `$${i + 1}`).join(', ');
    const created = await queryOne(
      `INSERT INTO client_addresses (${cols.join(', ')}) VALUES (${placeholders})
       RETURNING id, address1, address2, town AS city, province,
                 postal_code AS postal, address_type AS type`,
      vals
    );
    res.status(201).json(created);
  } catch (e) {
    console.error('POST /clients/:id/addresses:', e);
    res.status(500).json({ message: 'Failed to add address', detail: e.message });
  }
});

// ─── PUT /api/clients/addresses/:id ──────────────────────────────────────────
router.put('/addresses/:id', requireStaff, async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!Number.isInteger(id)) return res.status(400).json({ message: 'Invalid address id' });
  const { cols, vals } = extractFields(req.body, ADDRESS_WRITABLE);
  if (cols.length === 0) return res.status(400).json({ message: 'No updatable fields provided' });
  try {
    const set = cols.map((c, i) => `${c} = $${i + 1}`).join(', ');
    const updated = await queryOne(
      `UPDATE client_addresses SET ${set} WHERE id = $${cols.length + 1}
       RETURNING id, address1, address2, town AS city, province,
                 postal_code AS postal, address_type AS type`,
      [...vals, id]
    );
    if (!updated) return res.status(404).json({ message: 'Address not found' });
    res.json(updated);
  } catch (e) {
    console.error('PUT /clients/addresses/:id:', e);
    res.status(500).json({ message: 'Failed to update address', detail: e.message });
  }
});

// ─── DELETE /api/clients/addresses/:id ───────────────────────────────────────
router.delete('/addresses/:id', requireStaff, async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!Number.isInteger(id)) return res.status(400).json({ message: 'Invalid address id' });
  try {
    const deleted = await queryOne(
      'DELETE FROM client_addresses WHERE id = $1 RETURNING id',
      [id]
    );
    if (!deleted) return res.status(404).json({ message: 'Address not found' });
    res.json({ message: 'Deleted', id: deleted.id });
  } catch (e) {
    console.error('DELETE /clients/addresses/:id:', e);
    res.status(500).json({ message: 'Failed to delete address', detail: e.message });
  }
});

// ─── POST /api/clients/:id/phones ────────────────────────────────────────────
router.post('/:id/phones', requireStaff, async (req, res) => {
  const clientId = parseInt(req.params.id, 10);
  if (!Number.isInteger(clientId)) return res.status(400).json({ message: 'Invalid client id' });
  try {
    const { cols, vals } = extractFields(req.body, PHONE_WRITABLE);
    cols.unshift('client_id');
    vals.unshift(clientId);
    const placeholders = cols.map((_, i) => `$${i + 1}`).join(', ');
    const created = await queryOne(
      `INSERT INTO client_phones (${cols.join(', ')}) VALUES (${placeholders})
       RETURNING id, number AS phone_number, ext, phone_type AS type`,
      vals
    );
    res.status(201).json(created);
  } catch (e) {
    console.error('POST /clients/:id/phones:', e);
    res.status(500).json({ message: 'Failed to add phone', detail: e.message });
  }
});

// ─── PUT /api/clients/phones/:id ─────────────────────────────────────────────
router.put('/phones/:id', requireStaff, async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!Number.isInteger(id)) return res.status(400).json({ message: 'Invalid phone id' });
  const { cols, vals } = extractFields(req.body, PHONE_WRITABLE);
  if (cols.length === 0) return res.status(400).json({ message: 'No updatable fields provided' });
  try {
    const set = cols.map((c, i) => `${c} = $${i + 1}`).join(', ');
    const updated = await queryOne(
      `UPDATE client_phones SET ${set} WHERE id = $${cols.length + 1}
       RETURNING id, number AS phone_number, ext, phone_type AS type`,
      [...vals, id]
    );
    if (!updated) return res.status(404).json({ message: 'Phone not found' });
    res.json(updated);
  } catch (e) {
    console.error('PUT /clients/phones/:id:', e);
    res.status(500).json({ message: 'Failed to update phone', detail: e.message });
  }
});

// ─── DELETE /api/clients/phones/:id ──────────────────────────────────────────
router.delete('/phones/:id', requireStaff, async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!Number.isInteger(id)) return res.status(400).json({ message: 'Invalid phone id' });
  try {
    const deleted = await queryOne(
      'DELETE FROM client_phones WHERE id = $1 RETURNING id',
      [id]
    );
    if (!deleted) return res.status(404).json({ message: 'Phone not found' });
    res.json({ message: 'Deleted', id: deleted.id });
  } catch (e) {
    console.error('DELETE /clients/phones/:id:', e);
    res.status(500).json({ message: 'Failed to delete phone', detail: e.message });
  }
});

module.exports = router;
