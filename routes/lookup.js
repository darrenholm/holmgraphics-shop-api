// routes/lookup.js
// Clients, Employees, Statuses, ProjectTypes — the lookup/reference data
const express = require('express');
const { sql, query } = require('../db/connection');
const C = require('../db/column-map');
const { requireAuth, requireStaff } = require('../middleware/auth');
const router = express.Router();

const CL = C.Clients;
const CA = C.CAddress;
const CP = C.ClPhone;
const E  = C.Employee;
const S  = C.Status;
const PT = C.ProjectType;

// ─── GET /api/clients ────────────────────────────────────────────────────────
// Optional: ?search=smith
router.get('/clients', requireStaff, async (req, res) => {
  try {
    const { search } = req.query;
    let where = '';
    const params = {};

    if (search) {
      where = `WHERE [Company] LIKE @s
               OR [FName] LIKE @s
               OR [LName]  LIKE @s`;
      params.s = { type: sql.VarChar(255), value: `%${search}%` };
    }

    const rows = await query(
      `SELECT TOP 50
         [ID]        AS id,
         [Company]   AS company_name,
         [FName] AS first_name,
         [LName]  AS last_name,
         [Email]     AS email
       FROM Clients
       ${where}
       ORDER BY ISNULL([Company], [LName])`,
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

    const [client, addresses, phones] = await Promise.all([
      query(
        `SELECT [ID] AS id, [Company] AS company_name,
                [FName] AS first_name, [LName] AS last_name,
                [Email] AS email
         FROM Clients WHERE [ID] = @id`,
        { id: { type: sql.Int, value: id } }
      ),
      query(
        `SELECT a.[Address1] AS address1, a.[Address2] AS address2,
                a.[Town] AS city, a.[Province] AS province,
                a.[PostalCode] AS postal,
                t.AddressTypeName AS type
         FROM CAddress a
         LEFT JOIN AddressType t ON a.[AddressType] = t.AddressTypeID
         WHERE a.[ClientNo] = @id`,
        { id: { type: sql.Int, value: id } }
      ),
      query(
        `SELECT p.[Number] AS phone_number, t.PhoneTypeName AS type
         FROM ClPhone p
         LEFT JOIN PhoneType t ON p.[Type] = t.PhoneTypeID
         WHERE p.[ClNo] = @id`,
        { id: { type: sql.Int, value: id } }
      ),
    ]);

    if (!client[0]) return res.status(404).json({ message: 'Client not found' });
    res.json({ ...client[0], addresses, phones });
  } catch (e) {
    console.error('GET /clients/:id:', e);
    res.status(500).json({ message: 'Failed to load client', detail: e.message });
  }
});

// ─── GET /api/employees ──────────────────────────────────────────────────────
router.get('/employees', requireStaff, async (req, res) => {
  try {
    const rows = await query(
      `SELECT [EmpNo] AS id,
              [First] AS first_name,
              [Last]  AS last_name,
              [${E.email}]     AS email,
              [${E.role}]      AS role
       FROM Employee
       WHERE [Active] = 1 OR [Active] IS NULL
       ORDER BY [Last], [First]`
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
      `SELECT [ID] AS id, [Status] AS status_name
       FROM Status
       ORDER BY [ID]`
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
      `SELECT [ID] AS id, [ProjectType] AS type_name
       FROM ProjectType
       ORDER BY [ProjectType]`
    );
    res.json(rows);
  } catch (e) {
    console.error('GET /project-types:', e);
    res.status(500).json({ message: 'Failed to load project types', detail: e.message });
  }
});
router.post('/clients', requireStaff, async (req, res) => {
  const { company, first_name, last_name, email } = req.body;
  if (!company && !last_name) return res.status(400).json({ message: 'Company name or last name required' });
  try {
    const result = await query(
      `INSERT INTO Clients (Company, FName, LName, Email) OUTPUT INSERTED.ID AS id VALUES (@company, @fname, @lname, @email)`,
      { company: { type: sql.NVarChar(255), value: company || null }, fname: { type: sql.NVarChar(255), value: first_name || null }, lname: { type: sql.NVarChar(255), value: last_name || null }, email: { type: sql.NVarChar(sql.MAX), value: email || null } }
    );
    res.status(201).json({ id: result[0]?.id, message: 'Client created' });
  } catch (e) { res.status(500).json({ message: 'Failed to create client', detail: e.message }); }
});
module.exports = router;



