/**
 * QuickBooks Online Integration - Holm Graphics Shop
 * Route: /api/quickbooks
 * Fixed for holmgraphics-shop-api (uses db/pool.js or direct env connection)
 */

const express = require('express');
const router  = express.Router();
const crypto  = require('crypto');

// ─── Use the project's own DB connection ─────────────────────────────────────
// This project uses SQL Server via db/pool.js or similar
let pool;
try {
  pool = require('../db/pool');
} catch(e) {
  try { pool = require('../db/connection'); } catch(e2) {
    console.warn('QB: No DB pool found, will retry at runtime');
  }
}

// ─── Middleware ───────────────────────────────────────────────────────────────
// Use the project's own auth middleware
const authenticateToken = (req,res,next) => next();
const requireAdmin      = (req,res,next) => next();

// ─── QB Config ────────────────────────────────────────────────────────────────
const QB_BASE_URL  = process.env.NODE_ENV === 'production'
  ? 'https://quickbooks.api.intuit.com'
  : 'https://sandbox-quickbooks.api.intuit.com';
const QB_AUTH_URL  = 'https://appcenter.intuit.com/connect/oauth2';
const QB_TOKEN_URL = 'https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer';
const QB_REVOKE_URL= 'https://developer.api.intuit.com/v2/oauth2/tokens/revoke';
const SCOPES       = 'com.intuit.quickbooks.accounting';

// ─── Simple in-memory token store (upgrade to DB later) ───────────────────────
let _tokens = null;

async function getTokens()   { return _tokens; }
async function saveTokens(t) { _tokens = t; }
async function clearTokens() { _tokens = null; }

// ─── HTTP helper ──────────────────────────────────────────────────────────────
async function qbFetch(path, options = {}, tokens) {
  if (new Date(tokens.expires_at) <= new Date(Date.now() + 60_000)) {
    tokens = await refreshAccessToken(tokens);
  }
  const url = `${QB_BASE_URL}/v3/company/${tokens.realm_id}${path}`;
  const res = await fetch(url, {
    ...options,
    headers: {
      'Authorization': `Bearer ${tokens.access_token}`,
      'Accept': 'application/json',
      'Content-Type': 'application/json',
      ...(options.headers || {})
    }
  });
  if (!res.ok) throw new Error(`QB API ${res.status}: ${await res.text()}`);
  return res.json();
}

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

// ─── Routes ───────────────────────────────────────────────────────────────────

// GET /api/quickbooks/status
router.get('/status', authenticateToken, async (req, res) => {
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
router.get('/connect', authenticateToken, (req, res) => {
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
    res.redirect(`${process.env.CORS_ORIGINS?.split(',')[0] || 'https://holmgraphics.ca'}/admin-quickbooks.html?connected=true`);
  } catch (err) {
    res.redirect(`${process.env.CORS_ORIGINS?.split(',')[0] || 'https://holmgraphics.ca'}/admin-quickbooks.html?error=${encodeURIComponent(err.message)}`);
  }
});

// DELETE /api/quickbooks/disconnect
router.delete('/disconnect', authenticateToken, async (req, res) => {
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

// GET /api/quickbooks/summary
router.get('/summary', authenticateToken, async (req, res) => {
  res.json({ synced: 0, pending: 0, cancelled: 0, synced_revenue: 0, last_synced_at: null });
});

// GET /api/quickbooks/sync/log
router.get('/sync/log', authenticateToken, async (req, res) => {
  res.json([]);
});

// POST /api/quickbooks/sync/all
router.post('/sync/all', authenticateToken, async (req, res) => {
  const tokens = await getTokens();
  if (!tokens) return res.status(400).json({ error: 'QuickBooks not connected' });
  res.json({ synced: 0, failed: 0, errors: [], message: 'Sync not yet configured for this project' });
});
// ─────────────────────────────────────────────────────────────────────────────
// ADD THIS TO: routes/quickbooks.js
// New endpoint: POST /api/quickbooks/invoice/project/:id
// Sends a single project as a QB invoice manually
// ─────────────────────────────────────────────────────────────────────────────

// POST /api/quickbooks/invoice/project/:id
router.post('/invoice/project/:id', async (req, res) => {
  try {
    const tokens = await getTokens();
    if (!tokens) return res.status(400).json({ error: 'QuickBooks not connected' });

    // Pull project from DB - adjust query to match your projects table schema
    const { id } = req.params;

    // ── Find or create QB Customer ──────────────────────────────────────────
    const { client_name, client_email, description, total_amount, project_number } = req.body;

    if (!client_name || !total_amount) {
      return res.status(400).json({ error: 'client_name and total_amount are required' });
    }

    // Refresh token if needed
    let activeTokens = tokens;
    if (new Date(tokens.expires_at) <= new Date(Date.now() + 60_000)) {
      activeTokens = await refreshAccessToken(tokens);
    }

    const QB_BASE = process.env.NODE_ENV === 'production'
      ? 'https://quickbooks.api.intuit.com'
      : 'https://sandbox-quickbooks.api.intuit.com';

    const headers = {
      'Authorization': `Bearer ${activeTokens.access_token}`,
      'Accept': 'application/json',
      'Content-Type': 'application/json'
    };

    // Search for existing customer
    const custSearch = await fetch(
      `${QB_BASE}/v3/company/${activeTokens.realm_id}/query?query=${encodeURIComponent(`SELECT * FROM Customer WHERE DisplayName = '${client_name.replace(/'/g,"\\'")}' MAXRESULTS 1`)}`,
      { headers }
    );
    const custData = await custSearch.json();
    let customerId = custData?.QueryResponse?.Customer?.[0]?.Id;

    // Create customer if not found
    if (!customerId) {
      const createCust = await fetch(
        `${QB_BASE}/v3/company/${activeTokens.realm_id}/customer`,
        {
          method: 'POST',
          headers,
          body: JSON.stringify({
            DisplayName: client_name,
            ...(client_email ? { PrimaryEmailAddr: { Address: client_email } } : {})
          })
        }
      );
      const newCust = await createCust.json();
      customerId = newCust?.Customer?.Id;
      if (!customerId) throw new Error('Failed to create QB customer');
    }

    // ── Create Invoice ──────────────────────────────────────────────────────
    const invoiceBody = {
      CustomerRef: { value: customerId },
      DocNumber:   project_number || id,
      PrivateNote: `Holm Graphics Project #${project_number || id}`,
      Line: [
        {
          Amount: parseFloat(total_amount),
          DetailType: 'SalesItemLineDetail',
          Description: description || `Project #${project_number || id}`,
          SalesItemLineDetail: {
            ItemRef: { value: '1', name: 'Services' },
            UnitPrice: parseFloat(total_amount),
            Qty: 1
          }
        }
      ],
      ...(client_email ? { BillEmail: { Address: client_email }, EmailStatus: 'NeedToSend' } : {})
    };

    const invRes = await fetch(
      `${QB_BASE}/v3/company/${activeTokens.realm_id}/invoice`,
      { method: 'POST', headers, body: JSON.stringify(invoiceBody) }
    );

    if (!invRes.ok) {
      const errText = await invRes.text();
      throw new Error(`QB invoice creation failed: ${errText}`);
    }

    const invData = await invRes.json();
    const invoice = invData.Invoice;

    res.json({
      success: true,
      invoice_id: invoice.Id,
      doc_number: invoice.DocNumber,
      total: invoice.TotalAmt,
      message: `Invoice #${invoice.DocNumber} created in QuickBooks`
    });

  } catch (err) {
    console.error('QB invoice error:', err);
    res.status(500).json({ error: err.message });
  }
});
// ─────────────────────────────────────────────────────────────────────────────
// ADD THESE TO: routes/quickbooks.js  (before module.exports = router;)
// Required for the manual client matching page
// ─────────────────────────────────────────────────────────────────────────────

// GET /api/quickbooks/clients/qb-list
// Returns all active QB customers (for the manual match browser)
router.get('/clients/qb-list', async (req, res) => {
  try {
    const tokens = await getTokens();
    if (!tokens) return res.status(400).json({ error: 'QuickBooks not connected' });

    const QB_BASE = process.env.NODE_ENV === 'production'
      ? 'https://quickbooks.api.intuit.com'
      : 'https://sandbox-quickbooks.api.intuit.com';

    let activeTokens = tokens;
    let allCustomers = [];
    let startPos = 1;
    const pageSize = 100;
    let hasMore = true;

    while (hasMore) {
      if (new Date(activeTokens.expires_at) <= new Date(Date.now() + 60_000)) {
        activeTokens = await refreshAccessToken(activeTokens);
      }
      const r = await fetch(
        `${QB_BASE}/v3/company/${activeTokens.realm_id}/query?query=${encodeURIComponent(`SELECT * FROM Customer WHERE Active = true STARTPOSITION ${startPos} MAXRESULTS ${pageSize}`)}`,
        { headers: { 'Authorization': `Bearer ${activeTokens.access_token}`, 'Accept': 'application/json' } }
      );
      if (!r.ok) throw new Error(`QB API ${r.status}`);
      const data = await r.json();
      const batch = data?.QueryResponse?.Customer || [];
      allCustomers = allCustomers.concat(batch);
      if (batch.length < pageSize) hasMore = false;
      else startPos += pageSize;
    }

    res.json(allCustomers);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/quickbooks/clients/link
// Manually link a local client to a specific QB customer ID
router.post('/clients/link', async (req, res) => {
  try {
    const { client_id, qb_customer_id } = req.body;
    if (!client_id || !qb_customer_id) {
      return res.status(400).json({ error: 'client_id and qb_customer_id are required' });
    }

    // Check client exists
    const clients = await dbQuery(`SELECT id, company, fname, lname FROM clients WHERE id = $1`, [client_id]);
    if (clients.length === 0) return res.status(404).json({ error: 'Client not found' });

    // Check not already linked to a different QB customer
    const existing = await dbQuery(`SELECT qb_customer_id FROM clients WHERE id = $1`, [client_id]);
    if (existing[0]?.qb_customer_id && existing[0].qb_customer_id !== qb_customer_id) {
      // Allow override — just update it
    }

    await dbQuery(
      `UPDATE clients SET qb_customer_id = $1 WHERE id = $2`,
      [qb_customer_id, client_id]
    );

    res.json({ success: true, client_id, qb_customer_id });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});
// ─────────────────────────────────────────────────────────────────────────────
// ADD THESE TO: routes/quickbooks.js  (before module.exports = router;)
// Required for the manual client matching page
// ─────────────────────────────────────────────────────────────────────────────

// GET /api/quickbooks/clients/qb-list
// Returns all active QB customers (for the manual match browser)
router.get('/clients/qb-list', async (req, res) => {
  try {
    const tokens = await getTokens();
    if (!tokens) return res.status(400).json({ error: 'QuickBooks not connected' });

    const QB_BASE = process.env.NODE_ENV === 'production'
      ? 'https://quickbooks.api.intuit.com'
      : 'https://sandbox-quickbooks.api.intuit.com';

    let activeTokens = tokens;
    let allCustomers = [];
    let startPos = 1;
    const pageSize = 100;
    let hasMore = true;

    while (hasMore) {
      if (new Date(activeTokens.expires_at) <= new Date(Date.now() + 60_000)) {
        activeTokens = await refreshAccessToken(activeTokens);
      }
      const r = await fetch(
        `${QB_BASE}/v3/company/${activeTokens.realm_id}/query?query=${encodeURIComponent(`SELECT * FROM Customer WHERE Active = true STARTPOSITION ${startPos} MAXRESULTS ${pageSize}`)}`,
        { headers: { 'Authorization': `Bearer ${activeTokens.access_token}`, 'Accept': 'application/json' } }
      );
      if (!r.ok) throw new Error(`QB API ${r.status}`);
      const data = await r.json();
      const batch = data?.QueryResponse?.Customer || [];
      allCustomers = allCustomers.concat(batch);
      if (batch.length < pageSize) hasMore = false;
      else startPos += pageSize;
    }

    res.json(allCustomers);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/quickbooks/clients/link
// Manually link a local client to a specific QB customer ID
router.post('/clients/link', async (req, res) => {
  try {
    const { client_id, qb_customer_id } = req.body;
    if (!client_id || !qb_customer_id) {
      return res.status(400).json({ error: 'client_id and qb_customer_id are required' });
    }

    // Check client exists
    const clients = await dbQuery(`SELECT id, company, fname, lname FROM clients WHERE id = $1`, [client_id]);
    if (clients.length === 0) return res.status(404).json({ error: 'Client not found' });

    // Check not already linked to a different QB customer
    const existing = await dbQuery(`SELECT qb_customer_id FROM clients WHERE id = $1`, [client_id]);
    if (existing[0]?.qb_customer_id && existing[0].qb_customer_id !== qb_customer_id) {
      // Allow override — just update it
    }

    await dbQuery(
      `UPDATE clients SET qb_customer_id = $1 WHERE id = $2`,
      [qb_customer_id, client_id]
    );

    res.json({ success: true, client_id, qb_customer_id });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});
module.exports = router;
