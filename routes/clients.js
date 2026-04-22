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

module.exports = router;
