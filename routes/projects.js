const express = require('express');
const { sql, query, queryOne } = require('../db/connection');
const { requireAuth, requireStaff } = require('../middleware/auth');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const FormData = require('form-data');
const fetch = require('node-fetch');
const router = express.Router();

const WHC_UPLOAD_URL = 'https://holmgraphics.ca/shop-uploads/upload.php';
const WHC_UPLOAD_KEY = 'holmgraphics-upload-2026';
const WHC_BASE_URL   = 'https://holmgraphics.ca/shop-uploads/jobs';

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 20 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const allowed = /jpeg|jpg|png|gif|webp/;
    cb(null, allowed.test(path.extname(file.originalname).toLowerCase()));
  }
});

router.get('/gallery/public', async (req, res) => {
  try {
    const { category } = req.query;
    let where = 'GalleryInclude = 1';
    const params = {};
    if (category) {
      where += ' AND GalleryCategory = @category';
      params.category = { type: sql.NVarChar(50), value: category };
    }
    const photos = await query(
      `SELECT p.Filename, p.URL, p.GalleryCategory, p.UploadedAt, CAST(pr.Description AS NVARCHAR(500)) AS project_name FROM Photos p LEFT JOIN Projects pr ON p.ProjectNo = pr.JobNo WHERE ${where} ORDER BY p.UploadedAt DESC`,
      params
    );
    res.json(photos);
  } catch (e) { res.status(500).json({ message: 'Failed to load gallery', detail: e.message }); }
});

router.get('/', requireAuth, async (req, res) => {
  try {
    const { clientId, search } = req.query;
    let where = ['1=1'];
    const params = {};
    if (req.user.role === 'client') { where.push('p.Client = @clientId'); params.clientId = { type: sql.Int, value: req.user.clientId }; }
    else if (clientId) { where.push('p.Client = @clientId'); params.clientId = { type: sql.Int, value: parseInt(clientId) }; }
    if (search) { where.push("(CAST(p.JobNo AS NVARCHAR) LIKE @search OR CAST(p.Description AS NVARCHAR) LIKE @search OR c.Company LIKE @search OR c.FName LIKE @search OR c.LName LIKE @search)"); params.search = { type: sql.NVarChar(255), value: '%' + search + '%' }; }
    const rows = await query(`SELECT p.JobNo AS id, CAST(p.Description AS NVARCHAR(500)) AS project_name, p.Client AS client_id, p.Status AS status_id, p.ProjectType AS type_id, p.Production AS employee_id, p.Date AS date_created, p.DueDate AS due_date, p.Contact AS contact, p.ContactPhone AS contact_phone, ISNULL(c.Company, CONCAT(c.FName, ' ', c.LName)) AS client_name, s.Status AS status_name, pt.ProjectType AS project_type, CONCAT(e.First, ' ', e.Last) AS assigned_to FROM Projects p LEFT JOIN Clients c ON p.Client = c.ID LEFT JOIN Status s ON p.Status = s.ID LEFT JOIN ProjectType pt ON p.ProjectType = pt.ID LEFT JOIN Employee e ON p.Production = e.EmpNo WHERE ` + where.join(' AND ') + ` ORDER BY p.Date DESC`, params);
    res.json(rows);
  } catch (e) { console.error('GET /projects:', e); res.status(500).json({ message: 'Failed to load projects', detail: e.message }); }
});

router.get('/:id', requireAuth, async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    const row = await queryOne(`SELECT p.JobNo AS id, CAST(p.Description AS NVARCHAR(500)) AS project_name, p.Client AS client_id, p.Status AS status_id, p.ProjectType AS type_id, p.Production AS employee_id, p.Sales AS sales_id, p.Date AS date_created, p.DueDate AS due_date, p.Contact AS contact, p.ContactPhone AS contact_phone, CAST(p.ContactEmail AS NVARCHAR(500)) AS contact_email, p.FolderPath AS folder_path, ISNULL(c.Company, CONCAT(c.FName, ' ', c.LName)) AS client_name, CAST(c.Email AS NVARCHAR(500)) AS client_email, s.Status AS status_name, pt.ProjectType AS project_type, CONCAT(e.First, ' ', e.Last) AS assigned_to FROM Projects p LEFT JOIN Clients c ON p.Client = c.ID LEFT JOIN Status s ON p.Status = s.ID LEFT JOIN ProjectType pt ON p.ProjectType = pt.ID LEFT JOIN Employee e ON p.Production = e.EmpNo WHERE p.JobNo = @id`, { id: { type: sql.Int, value: id } });
    if (!row) return res.status(404).json({ message: 'Project not found' });
    if (req.user.role === 'client' && row.client_id !== req.user.clientId) return res.status(403).json({ message: 'Access denied' });
    const phones = await query(`SELECT cp.Number AS phone_number, cp.Ext AS ext, pt.Type AS phone_type FROM ClPhone cp LEFT JOIN PhoneType pt ON cp.Type = pt.ID WHERE cp.ClNo = @clientId`, { clientId: { type: sql.Int, value: row.client_id } });
    const measurements = await query(`SELECT ID AS id, Item AS item, [Height(in)] AS height, [Width(in)] AS width, CAST(Comment AS NVARCHAR(500)) AS notes FROM Measurements WHERE JobNo = @id`, { id: { type: sql.Int, value: id } });
    res.json({ ...row, client_phones: phones, measurements });
  } catch (e) { console.error('GET /projects/:id:', e); res.status(500).json({ message: 'Failed to load project', detail: e.message }); }
});

router.post('/', requireStaff, async (req, res) => {
  const { project_name, client_id, project_type_id, status_id, assigned_employee_id, due_date, contact, contact_phone, contact_email } = req.body;
  if (!project_name || !client_id) return res.status(400).json({ message: 'project_name and client_id are required' });
  try {
    const result = await query(`INSERT INTO Projects (Description, Client, ProjectType, Status, Production, DueDate, Contact, ContactPhone, ContactEmail, Date) OUTPUT INSERTED.JobNo AS id VALUES (@name, @clientId, @typeId, @statusId, @empId, @dueDate, @contact, @cPhone, @cEmail, CAST(GETDATE() AS DATE))`, { name: { type: sql.NVarChar(sql.MAX), value: project_name }, clientId: { type: sql.Int, value: parseInt(client_id) }, typeId: { type: sql.Int, value: project_type_id ? parseInt(project_type_id) : null }, statusId: { type: sql.Int, value: status_id ? parseInt(status_id) : null }, empId: { type: sql.Int, value: assigned_employee_id ? parseInt(assigned_employee_id) : null }, dueDate: { type: sql.DateTime2, value: due_date ? new Date(due_date) : null }, contact: { type: sql.NVarChar(255), value: contact || null }, cPhone: { type: sql.NVarChar(255), value: contact_phone || null }, cEmail: { type: sql.NVarChar(sql.MAX), value: contact_email || null } });
    res.status(201).json({ id: result[0]?.id, message: 'Project created' });
  } catch (e) { console.error('POST /projects:', e); res.status(500).json({ message: 'Failed to create project', detail: e.message }); }
});

router.put('/:id', requireStaff, async (req, res) => {
  const id = parseInt(req.params.id);
  const { project_name, client_id, project_type_id, status_id, assigned_employee_id, due_date, contact, contact_phone, contact_email, folder_path } = req.body;
  try {
    await query(`UPDATE Projects SET Description=@name, Client=@clientId, ProjectType=@typeId, Status=@statusId, Production=@empId, DueDate=@dueDate, Contact=@contact, ContactPhone=@cPhone, ContactEmail=@cEmail, FolderPath=@folderPath WHERE JobNo=@id`, { name: { type: sql.NVarChar(sql.MAX), value: project_name }, clientId: { type: sql.Int, value: parseInt(client_id) }, typeId: { type: sql.Int, value: project_type_id ? parseInt(project_type_id) : null }, statusId: { type: sql.Int, value: status_id ? parseInt(status_id) : null }, empId: { type: sql.Int, value: assigned_employee_id ? parseInt(assigned_employee_id) : null }, dueDate: { type: sql.DateTime2, value: due_date ? new Date(due_date) : null }, contact: { type: sql.NVarChar(255), value: contact || null }, cPhone: { type: sql.NVarChar(255), value: contact_phone || null }, cEmail: { type: sql.NVarChar(sql.MAX), value: contact_email || null }, folderPath: { type: sql.NVarChar(500), value: folder_path || null }, id: { type: sql.Int, value: id } });
    res.json({ message: 'Project updated' });
  } catch (e) { console.error('PUT /projects/:id:', e); res.status(500).json({ message: 'Failed to update project', detail: e.message }); }
});

router.get('/:id/notes', requireAuth, async (req, res) => {
  try {
    const rows = await query(`SELECT ID AS id, CAST(Note AS NVARCHAR(MAX)) AS note_text, Date AS note_date, 'Staff' AS employee_name FROM Notes WHERE ProjectNo = @id ORDER BY Date DESC`, { id: { type: sql.Int, value: parseInt(req.params.id) } });
    res.json(rows);
  } catch (e) { res.status(500).json({ message: 'Failed to load notes', detail: e.message }); }
});

router.post('/:id/notes', requireAuth, async (req, res) => {
  const { text } = req.body;
  if (!text?.trim()) return res.status(400).json({ message: 'Note text required' });
  try {
    await query(`INSERT INTO Notes (ProjectNo, Date, Time, Note) VALUES (@projectId, CAST(GETDATE() AS DATE), CAST(GETDATE() AS TIME), @text)`, { projectId: { type: sql.Int, value: parseInt(req.params.id) }, text: { type: sql.NVarChar(sql.MAX), value: text.trim() } });
    res.status(201).json({ message: 'Note added' });
  } catch (e) { res.status(500).json({ message: 'Failed to add note', detail: e.message }); }
});

router.post('/:id/status', requireStaff, async (req, res) => {
  const { statusId } = req.body;
  if (!statusId) return res.status(400).json({ message: 'statusId required' });
  try {
    await query(`UPDATE Projects SET Status = @statusId WHERE JobNo = @id`, { statusId: { type: sql.Int, value: parseInt(statusId) }, id: { type: sql.Int, value: parseInt(req.params.id) } });
    await query(`INSERT INTO StatusChange (ProjectNo, NewStatus, UpdateTime) VALUES (@projectId, @statusId, GETDATE())`, { projectId: { type: sql.Int, value: parseInt(req.params.id) }, statusId: { type: sql.Int, value: parseInt(statusId) } });
    res.json({ message: 'Status updated' });
  } catch (e) { res.status(500).json({ message: 'Failed to update status', detail: e.message }); }
});

const rows = await query(`SELECT ID AS id, CAST(Description AS NVARCHAR(500)) AS item_name, Qty AS quantity, Price AS unit_price, ExtPrice AS total, qb_item_name FROM Items WHERE ProjectNo = @id ORDER BY ID`,);
  } catch (e) { res.status(500).json({ message: 'Failed to load items', detail: e.message }); }
});

router.post('/:id/items', requireStaff, async (req, res) => {
  const { description, qty, price, total, qb_item_name } = req.body;
  if (!description?.trim()) return res.status(400).json({ message: 'Description required' });
  try {
    await query(`INSERT INTO Items (ProjectNo, Description, Qty, Price, ExtPrice, qb_item_name) VALUES (@projectId, @desc, @qty, @price, @total, @qbItem)`, { projectId: { type: sql.Int, value: parseInt(req.params.id) }, desc: { type: sql.NVarChar(sql.MAX), value: description.trim() }, qty: { type: sql.Float, value: parseFloat(qty) || 1 }, price: { type: sql.Float, value: parseFloat(price) || 0 }, total: { type: sql.Float, value: parseFloat(total) || 0 }, qbItem: { type: sql.NVarChar(100), value: qb_item_name || null } });
    res.status(201).json({ message: 'Item added' });
  } catch (e) { res.status(500).json({ message: 'Failed to add item', detail: e.message }); }
});

router.put('/:id/items/:itemId', requireStaff, async (req, res) => {
  const { description, qty, price, total } = req.body;
  try {
    await query(
      `UPDATE Items SET Description=@desc, Qty=@qty, Price=@price, ExtPrice=@total WHERE ID=@itemId AND ProjectNo=@projectId`,
      {
        desc:      { type: sql.NVarChar(sql.MAX), value: description },
        qty:       { type: sql.Float, value: parseFloat(qty) || 1 },
        price:     { type: sql.Float, value: parseFloat(price) || 0 },
        total:     { type: sql.Float, value: parseFloat(total) || 0 },
        itemId:    { type: sql.Int, value: parseInt(req.params.itemId) },
        projectId: { type: sql.Int, value: parseInt(req.params.id) }
      }
    );
    res.json({ message: 'Item updated' });
  } catch (e) { res.status(500).json({ message: 'Failed to update item', detail: e.message }); }
});

router.delete('/:id/items/:itemId', requireStaff, async (req, res) => {
  try {
    await query(
      `DELETE FROM Items WHERE ID=@itemId AND ProjectNo=@projectId`,
      {
        itemId:    { type: sql.Int, value: parseInt(req.params.itemId) },
        projectId: { type: sql.Int, value: parseInt(req.params.id) }
      }
    );
    res.json({ message: 'Item deleted' });
  } catch (e) { res.status(500).json({ message: 'Failed to delete item', detail: e.message }); }
});

router.post('/:id/measurements', requireStaff, async (req, res) => {
  const { item, width, height, qty, notes } = req.body;
  try {
    await query(`INSERT INTO Measurements (JobNo, Item, [Width(in)], [Height(in)], Comment) VALUES (@jobNo, @item, @width, @height, @notes)`, { jobNo: { type: sql.Int, value: parseInt(req.params.id) }, item: { type: sql.NVarChar(sql.MAX), value: item || null }, width: { type: sql.Float, value: parseFloat(width) || null }, height: { type: sql.Float, value: parseFloat(height) || null }, notes: { type: sql.NVarChar(sql.MAX), value: notes || null } });
    res.status(201).json({ message: 'Measurement added' });
  } catch (e) { res.status(500).json({ message: 'Failed to add measurement', detail: e.message }); }
});

router.get('/:id/photos', requireAuth, async (req, res) => {
  try {
    const dbPhotos = await query(
      `SELECT Filename, URL, GalleryInclude, GalleryCategory, UploadedAt FROM Photos WHERE ProjectNo = @id ORDER BY UploadedAt DESC`,
      { id: { type: sql.Int, value: parseInt(req.params.id) } }
    );
    const result = dbPhotos.map(p => ({
      filename: p.Filename,
      url: p.URL,
      uploaded: p.UploadedAt,
      gallery_include: p.GalleryInclude === true || p.GalleryInclude === 1,
      gallery_category: p.GalleryCategory || null
    }));
    res.json(result);
  } catch (e) { res.status(500).json({ message: 'Failed to load photos', detail: e.message }); }
});

router.post('/:id/photos', requireStaff, upload.array('photos', 20), async (req, res) => {
  try {
    const projectId = parseInt(req.params.id);
    const uploaded = [];
    for (const file of req.files) {
      const form = new FormData();
      form.append('job_id', String(projectId));
      form.append('photo', file.buffer, { filename: file.originalname, contentType: file.mimetype });
      const whcRes = await fetch(WHC_UPLOAD_URL, {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${WHC_UPLOAD_KEY}`, ...form.getHeaders() },
        body: form
      });
      if (!whcRes.ok) { console.error('WHC upload error:', await whcRes.text()); continue; }
      const data = await whcRes.json();
      if (!data.success) continue;
      await query(
        `INSERT INTO Photos (ProjectNo, Filename, URL) VALUES (@projectId, @filename, @url)`,
        { projectId: { type: sql.Int, value: projectId }, filename: { type: sql.NVarChar(255), value: data.filename }, url: { type: sql.NVarChar(500), value: data.url } }
      );
      uploaded.push({ filename: data.filename, url: data.url });
    }
    res.status(201).json({ message: `${uploaded.length} photo(s) uploaded`, files: uploaded });
  } catch (e) { console.error('POST photos:', e); res.status(500).json({ message: 'Failed to upload photos', detail: e.message }); }
});

router.delete('/:id/photos/:filename', requireStaff, async (req, res) => {
  try {
    await query(
      `DELETE FROM Photos WHERE ProjectNo = @projectId AND Filename = @filename`,
      { projectId: { type: sql.Int, value: parseInt(req.params.id) }, filename: { type: sql.NVarChar(255), value: req.params.filename } }
    );
    res.json({ message: 'Photo deleted' });
  } catch (e) { res.status(500).json({ message: 'Failed to delete photo', detail: e.message }); }
});

router.put('/:id/photos/:filename/gallery', requireStaff, async (req, res) => {
  const { gallery_include, gallery_category } = req.body;
  const projectId = parseInt(req.params.id);
  const filename = req.params.filename;
  try {
    const existing = await queryOne(
      `SELECT ID FROM Photos WHERE ProjectNo = @projectId AND Filename = @filename`,
      { projectId: { type: sql.Int, value: projectId }, filename: { type: sql.NVarChar(255), value: filename } }
    );
    if (existing) {
      await query(
        `UPDATE Photos SET GalleryInclude = @include, GalleryCategory = @category WHERE ProjectNo = @projectId AND Filename = @filename`,
        { include: { type: sql.Bit, value: gallery_include ? 1 : 0 }, category: { type: sql.NVarChar(50), value: gallery_category || null }, projectId: { type: sql.Int, value: projectId }, filename: { type: sql.NVarChar(255), value: filename } }
      );
    } else {
      await query(
        `INSERT INTO Photos (ProjectNo, Filename, URL, GalleryInclude, GalleryCategory) VALUES (@projectId, @filename, @url, @include, @category)`,
        { projectId: { type: sql.Int, value: projectId }, filename: { type: sql.NVarChar(255), value: filename }, url: { type: sql.NVarChar(500), value: `${WHC_BASE_URL}/${projectId}/${filename}` }, include: { type: sql.Bit, value: gallery_include ? 1 : 0 }, category: { type: sql.NVarChar(50), value: gallery_category || null } }
      );
    }
    res.json({ message: 'Gallery settings updated' });
  } catch (e) { res.status(500).json({ message: 'Failed to update gallery settings', detail: e.message }); }
});

router.put('/:id/folder', requireStaff, async (req, res) => {
  const { folder_path } = req.body;
  try {
    await query(`UPDATE Projects SET FolderPath = @path WHERE JobNo = @id`, { path: { type: sql.NVarChar(500), value: folder_path || null }, id: { type: sql.Int, value: parseInt(req.params.id) } });
    res.json({ message: 'Folder path updated' });
  } catch (e) { res.status(500).json({ message: 'Failed to update folder path', detail: e.message }); }
});
// GET /api/projects/qb-items
router.get('/qb-items', async (req, res) => {
  try {
    const { query } = require('../db/connection');
    const items = await query(
      `SELECT id, name, item_type, category, price, description 
       FROM QBItems WHERE active = 1 
       ORDER BY category ASC, name ASC`
    );
    res.json(items);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
