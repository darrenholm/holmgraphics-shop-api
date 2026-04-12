// db/column-map.js
// After running: node db/discover-schema.js
// Update any column names below that differ from your actual Azure SQL schema.
// The API routes import from here so you only fix one place.

module.exports = {
  Projects: {
    id:           'ProjectID',      // Primary key
    name:         'ProjectName',    // Job name/title
    clientId:     'ClientID',       // FK → Clients
    statusId:     'StatusID',       // FK → Status
    typeId:       'ProjectTypeID',  // FK → ProjectType
    employeeId:   'EmployeeID',     // FK → Employee (assigned to)
    dateCreated:  'DateCreated',
    dueDate:      'DueDate',
    poNumber:     'PONumber',
    description:  'Description',
    notes:        'Notes',          // inline notes field (if exists)
  },

  Clients: {
    id:           'ClientID',
    company:      'CompanyName',
    firstName:    'FirstName',
    lastName:     'LastName',
    email:        'Email',
  },

  CAddress: {
    id:           'AddressID',
    clientId:     'ClientID',
    typeId:       'AddressTypeID',
    address1:     'Address1',
    address2:     'Address2',
    city:         'City',
    province:     'Province',
    postal:       'PostalCode',
  },

  ClPhone: {
    id:           'PhoneID',
    clientId:     'ClientID',
    typeId:       'PhoneTypeID',
    number:       'PhoneNumber',
  },

  Employee: {
    id:           'EmployeeID',
    firstName:    'FirstName',
    lastName:     'LastName',
    email:        'Email',
    role:         'Role',           // 'admin' | 'staff' | 'client'
    passwordHash: 'PasswordHash',   // bcrypt hash — added by setup-auth.sql
    active:       'Active',
  },

  Status: {
    id:           'StatusID',
    name:         'StatusName',
    sortOrder:    'SortOrder',
  },

  StatusChange: {
    id:           'ChangeID',
    projectId:    'ProjectID',
    statusId:     'StatusID',
    employeeId:   'EmployeeID',
    changeDate:   'ChangeDate',
    note:         'Note',
  },

  Notes: {
    id:           'NoteID',
    projectId:    'ProjectID',
    employeeId:   'EmployeeID',
    text:         'NoteText',
    date:         'NoteDate',
  },

  Items: {
    id:           'ItemID',
    projectId:    'ProjectID',
    name:         'ItemName',
    description:  'Description',
    quantity:     'Quantity',
    unitPrice:    'UnitPrice',
    total:        'Total',
  },

  Measurements: {
    id:           'MeasurementID',
    projectId:    'ProjectID',
    width:        'Width',
    height:       'Height',
    quantity:     'Quantity',
    material:     'Material',
    notes:        'Notes',
  },

  ProjectType: {
    id:           'ProjectTypeID',
    name:         'ProjectTypeName',
  },
};

// ─── HOW TO USE ────────────────────────────────────────────────────────────
// In a route file:
//   const C = require('../db/column-map');
//   const col = C.Projects;
//   query(`SELECT [${col.id}] AS id, [${col.name}] AS name FROM Projects`)
//
// If discover-schema.js shows a different column name, just update the
// right-hand side value above — no other files need to change.
