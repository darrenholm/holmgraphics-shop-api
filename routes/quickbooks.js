/**
 * QuickBooks Online Integration - Holm Graphics Shop
 * Route: /api/quickbooks
 */

const express = require('express');
const router  = express.Router();
const crypto  = require('crypto');

// ─── Auth middleware (passthrough for now) ────────────────────────────────────
const authenticateToken = (req, res, next) => next();
const requireAdmin      = (req, res, next) => next();

// ─── QB Config ────────────────────────────────────────────────────────────────
const QB_AUTH_URL   = 'https://appcenter.intuit.com/connect/oauth2';
const QB_TOKEN_URL  = 'https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer';
const QB_REVOKE_URL = 'https://developer.api.intuit.com/v2/oauth2/tokens/revoke';
const SCOPES        = 'com.intuit.quickbooks.accounting';

function QB_BASE() {
  return process.env.NODE_ENV === 'production'
    ? 'https://quickbooks.api.intuit.com'
    : 'https://sandbox-quickbooks.api.intuit.com';
}

// ─── In-memory token store ────────────────────────────────────────────────────
let _tokens = null;
async function getTokens()   { return _tokens; }
async function saveTokens(t) { _tokens = t; }
async function clearTokens() { _tokens = null; }

// ─── Token refresh ────────────────────────────────────────────────────────────
async function refreshAccessToken(tokens) {
  const creds = Buffer.from(`${process.env.QB_CLIENT_ID}:${process.env.QB_CLIENT_SECRET}`).toString('base64');
  const res = await fetch(QB_TOKEN_URL, {
    method: 'POST',
    headers: { 'Authorization': `Basic ${creds}`, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: tokens.refresh_token })
  });
  if (!res.ok) throw new Error('QB token refresh failed');
  const data = await res.json();
  const newTokens = {
    access_token:  data.access_token,
    refresh_token: data.refresh_token || tokens.refresh_token,
    realm_id:      tokens.realm_id,
    expires_at:    new Date(Date.now() + data.expires_in * 1000).toISOString()
  };
  await saveTokens(newTokens);
  return newTokens;
}

// ─── Active tokens (auto-refresh) ────────────────────────────────────────────
async function activeTokens() {
  let t = await getTokens();
  if (!t) throw new Error('QuickBooks not connected');
  if (new Date(t.expires_at) <= new Date(Date.now() + 60_000)) {
    t = await refreshAccessToken(t);
  }
  return t;
}

// ─── QB HTTP helpers ──────────────────────────────────────────────────────────
async function qbGet(path) {
  const t = await activeTokens();
  const res = await fetch(`${QB_BASE()}/v3/company/${t.realm_id}${path}`, {
    headers: { 'Authorization': `Bearer ${t.access_token}`, 'Accept': 'application/json' }
  });
  if (!res.ok) throw new Error(`QB API ${res.status}: ${await res.text()}`);
  return res.json();
}

async function qbPost(path, body) {
  const t = await activeTokens();
  const res = await fetch(`${QB_BASE()}/v3/company/${t.realm_id}${path}`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${t.access_token}`,
      'Accept': 'application/json',
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(body)
  });
  if (!res.ok) throw new Error(`QB API ${res.status}: ${await res.text()}`);
  return res.json();
}

// ─── DB helper (Azure SQL via mssql) ─────────────────────────────────────────
async function dbQuery(sql_text, params = []) {
  const { getPool, sql } = require('../db/connection');
  const pool = await getPool();
  const request = pool.request();
  let i = 0;
  const converted = sql_text.replace(/\$\d+/g, () => {
    const name = `p${i}`;
    const val = params[i];
    request.input(name, val);
    i++;
    return `@${name}`;
  });
  const result = await request.query(converted);
  return result.recordset;
}

// ─────────────────────────────────────────────────────────────────────────────
// AUTH ROUTES
// ─────────────────────────────────────────────────────────────────────────────

// GET /api/quickbooks/status
router.get('/status', async (req, res) => {
  try {
    const tokens = await getTokens();
    if (!tokens) return res.json({ connected: false });
    res.json({
      connected:  true,
      realm_id:   tokens.realm_id,
      expires_at: tokens.expires_at,
      is_expired: new Date(tokens.expires_at) <= new Date()
    });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// GET /api/quickbooks/connect
router.get('/connect', (req, res) => {
  const params = new URLSearchParams({
    client_id:     process.env.QB_CLIENT_ID,
    redirect_uri:  process.env.QB_REDIRECT_URI,
    response_type: 'code',
    scope:         SCOPES,
    state:         crypto.randomBytes(16).toString('hex')
  });
  res.redirect(`${QB_AUTH_URL}?${params}`);
});

// GET /api/quickbooks/callback
router.get('/callback', async (req, res) => {
  const { code, realmId } = req.query;
  if (!code || !realmId) return res.status(400).send('Missing OAuth params');
  try {
    const creds = Buffer.from(`${process.env.QB_CLIENT_ID}:${process.env.QB_CLIENT_SECRET}`).toString('base64');
    const tokenRes = await fetch(QB_TOKEN_URL, {
      method: 'POST',
      headers: { 'Authorization': `Basic ${creds}`, 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'authorization_code', code, redirect_uri: process.env.QB_REDIRECT_URI })
    });
    if (!tokenRes.ok) throw new Error('Token exchange failed');
    const data = await tokenRes.json();
    await saveTokens({
      access_token:  data.access_token,
      refresh_token: data.refresh_token,
      realm_id:      realmId,
      expires_at:    new Date(Date.now() + data.expires_in * 1000).toISOString()
    });
    const base = process.env.CORS_ORIGINS?.split(',')[0] || 'https://holmgraphics.ca';
    res.redirect(`${base}/admin-quickbooks.html?connected=true`);
  } catch (err) {
    const base = process.env.CORS_ORIGINS?.split(',')[0] || 'https://holmgraphics.ca';
    res.redirect(`${base}/admin-quickbooks.html?error=${encodeURIComponent(err.message)}`);
  }
});

// DELETE /api/quickbooks/disconnect
router.delete('/disconnect', async (req, res) => {
  try {
    const tokens = await getTokens();
    if (tokens) {
      const creds = Buffer.from(`${process.env.QB_CLIENT_ID}:${process.env.QB_CLIENT_SECRET}`).toString('base64');
      await fetch(QB_REVOKE_URL, {
        method: 'POST',
        headers: { 'Authorization': `Basic ${creds}`, 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ token: tokens.refresh_token })
      });
      await clearTokens();
    }
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ─────────────────────────────────────────────────────────────────────────────
// DASHBOARD / SUMMARY
// ─────────────────────────────────────────────────────────────────────────────

// GET /api/quickbooks/summary
router.get('/summary', async (req, res) => {
  try {
    const rows = await dbQuery(`
      SELECT
        SUM(CASE WHEN qb_customer_id IS NOT NULL THEN 1 ELSE 0 END) AS synced,
        SUM(CASE WHEN qb_customer_id IS NULL THEN 1 ELSE 0 END) AS pending,
        0 AS cancelled,
        0 AS synced_revenue,
        NULL AS last_synced_at
      FROM Clients
    `);
    res.json(rows[0]);
  } catch (err) {
    res.json({ synced: 0, pending: 0, cancelled: 0, synced_revenue: 0, last_synced_at: null });
  }
});

// GET /api/quickbooks/sync/log
router.get('/sync/log', async (req, res) => {
  res.json([]);
});

// POST /api/quickbooks/sync/all
router.post('/sync/all', async (req, res) => {
  res.json({ synced: 0, failed: 0, errors: [], message: 'Use /clients/push to sync clients' });
});

// GET /api/quickbooks/taxcodes  — diagnostic route
router.get('/taxcodes', async (req, res) => {
  try {
    const data = await qbGet(`/query?query=${encodeURIComponent('SELECT * FROM TaxCode')}`);
    res.json(data);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ─────────────────────────────────────────────────────────────────────────────
// INVOICE
// ─────────────────────────────────────────────────────────────────────────────

// POST /api/quickbooks/invoice/project/:id
router.post('/invoice/project/:id', async (req, res) => {
  try {
    const { client_name, client_email, description, total_amount, project_number } = req.body;
    if (!client_name || !total_amount) {
      return res.status(400).json({ error: 'client_name and total_amount are required' });
    }

    // Find or create QB customer
    const searchData = await qbGet(
      `/query?query=${encodeURIComponent(`SELECT * FROM Customer WHERE DisplayName = '${client_name.replace(/'/g,"\\'")}' MAXRESULTS 1`)}`
    );
    let customerId = searchData?.QueryResponse?.Customer?.[0]?.Id;

    if (!customerId) {
      const newCust = await qbPost('/customer', {
        DisplayName: client_name,
        ...(client_email ? { PrimaryEmailAddr: { Address: client_email } } : {})
      });
      customerId = newCust?.Customer?.Id;
      if (!customerId) throw new Error('Failed to create QB customer');
    }

    // Look up the 'Misc' item in QB for the ItemRef
    const itemSearch = await qbGet(
      `/query?query=${encodeURIComponent(`SELECT * FROM Item WHERE Name = 'Misc' MAXRESULTS 1`)}`
    );
    const miscItemId = itemSearch?.QueryResponse?.Item?.[0]?.Id || '1';

    // Create invoice with HST ON (tax code ID 7) via minorversion=65
    const invData = await qbPost('/invoice?minorversion=65', {
      CustomerRef: { value: customerId },
      DocNumber:   String(project_number || req.params.id),
      PrivateNote: `Holm Graphics Project #${project_number || req.params.id}`,
      Line: [{
        Amount:      parseFloat(total_amount),
        DetailType:  'SalesItemLineDetail',
        Description: description || `Project #${project_number || req.params.id}`,
        SalesItemLineDetail: {
          ItemRef:    { value: miscItemId },
          UnitPrice:  parseFloat(total_amount),
          Qty:        1,
          TaxCodeRef: { value: '7' }
        }
      }],
      TxnTaxDetail: {
        TxnTaxCodeRef: { value: '7' },
        TotalTax: 0
      },
      ...(client_email ? { BillEmail: { Address: client_email }, EmailStatus: 'NeedToSend' } : {})
    });

    const invoice = invData.Invoice;
    res.json({
      success:    true,
      invoice_id: invoice.Id,
      doc_number: invoice.DocNumber,
      total:      invoice.TotalAmt,
      message:    `Invoice #${invoice.DocNumber} created in QuickBooks`
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// CLIENT SYNC
// ─────────────────────────────────────────────────────────────────────────────

// GET /api/quickbooks/clients/status
router.get('/clients/status', async (req, res) => {
  try {
    const rows = await dbQuery(`
      SELECT
        COUNT(*) AS total,
        COUNT(qb_customer_id) AS synced_to_qb,
        COUNT(*) - COUNT(qb_customer_id) AS not_in_qb
      FROM Clients
    `);
    res.json(rows[0]);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// GET /api/quickbooks/clients/list
router.get('/clients/list', async (req, res) => {
  try {
    const rows = await dbQuery(`
      SELECT id, company, fname, lname, CAST(email AS NVARCHAR(500)) as email, qb_customer_id
      FROM Clients ORDER BY company ASC, lname ASC
    `);
    res.json(rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// GET /api/quickbooks/clients/qb-list
router.get('/clients/qb-list', async (req, res) => {
  try {
    let allCustomers = [];
    let startPos = 1;
    const pageSize = 100;
    let hasMore = true;
    while (hasMore) {
      const data = await qbGet(
        `/query?query=${encodeURIComponent(`SELECT * FROM Customer WHERE Active = true STARTPOSITION ${startPos} MAXRESULTS ${pageSize}`)}`
      );
      const batch = data?.QueryResponse?.Customer || [];
      allCustomers = allCustomers.concat(batch);
      if (batch.length < pageSize) hasMore = false;
      else startPos += pageSize;
    }
    res.json(allCustomers);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// POST /api/quickbooks/clients/push  — push all unsynced local clients to QB
router.post('/clients/push', async (req, res) => {
  try {
    const unsynced = await dbQuery(`SELECT * FROM Clients WHERE qb_customer_id IS NULL`);
    const results = { pushed: 0, failed: 0, errors: [] };

    for (const client of unsynced) {
      try {
        const displayName = client.company ||
          [client.fname, client.lname].filter(Boolean).join(' ') ||
          client.email || `Client #${client.id}`;

        const searchData = await qbGet(
          `/query?query=${encodeURIComponent(`SELECT * FROM Customer WHERE DisplayName = '${displayName.replace(/'/g,"\\'")}' MAXRESULTS 1`)}`
        );
        let qbId = searchData?.QueryResponse?.Customer?.[0]?.Id;

        if (!qbId) {
          const created = await qbPost('/customer', {
            DisplayName: displayName,
            ...(client.fname ? { GivenName: client.fname } : {}),
            ...(client.lname ? { FamilyName: client.lname } : {}),
            ...(client.email ? { PrimaryEmailAddr: { Address: client.email } } : {})
          });
          qbId = created?.Customer?.Id;
        }

        if (qbId) {
          await dbQuery(`UPDATE Clients SET qb_customer_id = $1 WHERE id = $2`, [qbId, client.id]);
          results.pushed++;
        }
      } catch (err) {
        results.failed++;
        results.errors.push({ client_id: client.id, error: err.message });
      }
    }
    res.json(results);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// POST /api/quickbooks/clients/push/:id  — push single client to QB
router.post('/clients/push/:id', async (req, res) => {
  try {
    const clients = await dbQuery(`SELECT * FROM Clients WHERE id = $1`, [req.params.id]);
    if (!clients.length) return res.status(404).json({ error: 'Client not found' });
    const client = clients[0];
    if (client.qb_customer_id) return res.json({ already_synced: true, qb_customer_id: client.qb_customer_id });

    const displayName = client.company ||
      [client.fname, client.lname].filter(Boolean).join(' ') ||
      client.email || `Client #${client.id}`;

    const created = await qbPost('/customer', {
      DisplayName: displayName,
      ...(client.fname ? { GivenName: client.fname } : {}),
      ...(client.lname ? { FamilyName: client.lname } : {}),
      ...(client.email ? { PrimaryEmailAddr: { Address: client.email } } : {})
    });
    const qbId = created?.Customer?.Id;
    if (qbId) await dbQuery(`UPDATE Clients SET qb_customer_id = $1 WHERE id = $2`, [qbId, client.id]);
    res.json({ success: true, qb_customer_id: qbId, display_name: displayName });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// POST /api/quickbooks/clients/pull  — import QB customers into local DB
router.post('/clients/pull', async (req, res) => {
  try {
    const results = { imported: 0, updated: 0, skipped: 0, errors: [] };
    let startPos = 1;
    const pageSize = 100;
    let hasMore = true;

    while (hasMore) {
      const data = await qbGet(
        `/query?query=${encodeURIComponent(`SELECT * FROM Customer WHERE Active = true STARTPOSITION ${startPos} MAXRESULTS ${pageSize}`)}`
      );
      const customers = data?.QueryResponse?.Customer || [];
      if (!customers.length) { hasMore = false; break; }

      for (const cust of customers) {
        try {
          const existing = await dbQuery(`SELECT id FROM Clients WHERE qb_customer_id = $1`, [cust.Id]);
          if (existing.length) { results.skipped++; continue; }

          const email = cust.PrimaryEmailAddr?.Address || null;
          if (email) {
            const byEmail = await dbQuery(`SELECT id FROM Clients WHERE email = $1 AND qb_customer_id IS NULL`, [email]);
            if (byEmail.length) {
              await dbQuery(`UPDATE Clients SET qb_customer_id = $1 WHERE id = $2`, [cust.Id, byEmail[0].id]);
              results.updated++;
              continue;
            }
          }

          await dbQuery(
            `INSERT INTO Clients (company, fname, lname, email, qb_customer_id) VALUES ($1, $2, $3, $4, $5)`,
            [cust.CompanyName || cust.DisplayName || '', cust.GivenName || '', cust.FamilyName || '', email, cust.Id]
          );
          results.imported++;
        } catch (err) {
          results.errors.push({ qb_id: cust.Id, error: err.message });
        }
      }
      if (customers.length < pageSize) hasMore = false;
      else startPos += pageSize;
    }
    res.json(results);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// POST /api/quickbooks/clients/link  — manually link a client to a QB customer
router.post('/clients/link', async (req, res) => {
  try {
    const { client_id, qb_customer_id } = req.body;
    if (!client_id || !qb_customer_id) return res.status(400).json({ error: 'client_id and qb_customer_id are required' });
    const clients = await dbQuery(`SELECT id FROM Clients WHERE id = $1`, [client_id]);
    if (!clients.length) return res.status(404).json({ error: 'Client not found' });
    await dbQuery(`UPDATE Clients SET qb_customer_id = $1 WHERE id = $2`, [qb_customer_id, client_id]);
    res.json({ success: true, client_id, qb_customer_id });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

module.exports = router;
