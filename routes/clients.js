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

module.exports = router;
