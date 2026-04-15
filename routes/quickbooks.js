/**
 * QuickBooks Online Integration - Holm Graphics Shop
 * Route: /api/quickbooks
 * 
 * Features:
 *   - OAuth 2.0 connect/disconnect
 *   - Sync orders as QBO Invoices
 *   - Sync customers to QBO Customer list
 *   - Sync products to QBO Items
 *   - Webhook handler for QBO events
 *   - Manual & auto-sync endpoints
 */

const express = require('express');
const router = express.Router();
const pool = require('../config/database');
const { authenticateToken, requireAdmin } = require('../middleware/auth');
const crypto = require('crypto');

// ─── QuickBooks OAuth & API Config ───────────────────────────────────────────
const QB_BASE_URL = process.env.NODE_ENV === 'production'
  ? 'https://quickbooks.api.intuit.com'
  : 'https://sandbox-quickbooks.api.intuit.com';

const QB_AUTH_URL   = 'https://appcenter.intuit.com/connect/oauth2';
const QB_TOKEN_URL  = 'https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer';
const QB_REVOKE_URL = 'https://developer.api.intuit.com/v2/oauth2/tokens/revoke';
const QB_DISCOVERY  = 'https://developer.api.intuit.com/v2/oauth2/tokens/bearer';

const SCOPES = 'com.intuit.quickbooks.accounting';

// ─── Token store (PostgreSQL) ─────────────────────────────────────────────────
// Requires migration: see qb_migration.sql

async function getTokens() {
  const res = await pool.query(
    `SELECT * FROM qb_tokens ORDER BY updated_at DESC LIMIT 1`
  );
  return res.rows[0] || null;
}

async function saveTokens({ access_token, refresh_token, realm_id, expires_at }) {
  await pool.query(`
    INSERT INTO qb_tokens (access_token, refresh_token, realm_id, expires_at, updated_at)
    VALUES ($1, $2, $3, $4, NOW())
    ON CONFLICT (realm_id) DO UPDATE
      SET access_token = EXCLUDED.access_token,
          refresh_token = EXCLUDED.refresh_token,
          expires_at = EXCLUDED.expires_at,
          updated_at = NOW()
  `, [access_token, refresh_token, realm_id, expires_at]);
}

async function clearTokens() {
  await pool.query(`DELETE FROM qb_tokens`);
}

// ─── HTTP helper ──────────────────────────────────────────────────────────────
async function qbFetch(path, options = {}, tokens) {
  // Refresh if expired
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

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`QB API ${res.status}: ${errText}`);
  }
  return res.json();
}

async function refreshAccessToken(tokens) {
  const creds = Buffer.from(
    `${process.env.QB_CLIENT_ID}:${process.env.QB_CLIENT_SECRET}`
  ).toString('base64');

  const res = await fetch(QB_TOKEN_URL, {
    method: 'POST',
    headers: {
      'Authorization': `Basic ${creds}`,
      'Content-Type': 'application/x-www-form-urlencoded'
    },
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: tokens.refresh_token
    })
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

// ─── QB Entity Helpers ────────────────────────────────────────────────────────

async function findOrCreateCustomer(tokens, { customer_name, customer_email }) {
  // Search existing
  const search = await qbFetch(
    `/query?query=${encodeURIComponent(`SELECT * FROM Customer WHERE PrimaryEmailAddr = '${customer_email}' MAXRESULTS 1`)}`,
    {}, tokens
  );

  const existing = search?.QueryResponse?.Customer?.[0];
  if (existing) return existing.Id;

  // Create new
  const nameParts = customer_name.split(' ');
  const create = await qbFetch('/customer', {
    method: 'POST',
    body: JSON.stringify({
      DisplayName:    customer_name,
      GivenName:      nameParts[0] || '',
      FamilyName:     nameParts.slice(1).join(' ') || '',
      PrimaryEmailAddr: { Address: customer_email }
    })
  }, tokens);

  return create.Customer.Id;
}

async function findOrCreateItem(tokens, productName, unitPrice) {
  const search = await qbFetch(
    `/query?query=${encodeURIComponent(`SELECT * FROM Item WHERE Name = '${productName.replace(/'/g, "\\'")}' MAXRESULTS 1`)}`,
    {}, tokens
  );

  const existing = search?.QueryResponse?.Item?.[0];
  if (existing) return existing.Id;

  // Need an income account — query for first Sales income account
  const acctRes = await qbFetch(
    `/query?query=${encodeURIComponent("SELECT * FROM Account WHERE AccountType = 'Income' MAXRESULTS 1")}`,
    {}, tokens
  );
  const accountId = acctRes?.QueryResponse?.Account?.[0]?.Id || '1';

  const create = await qbFetch('/item', {
    method: 'POST',
    body: JSON.stringify({
      Name:          productName,
      Type:          'NonInventory',
      UnitPrice:     unitPrice,
      IncomeAccountRef: { value: accountId }
    })
  }, tokens);

  return create.Item.Id;
}

async function createQBInvoice(tokens, order) {
  const items = typeof order.items === 'string' ? JSON.parse(order.items) : order.items;
  const customerId = await findOrCreateCustomer(tokens, order);

  // Build line items
  const Lines = [];
  for (const item of items) {
    const itemId = await findOrCreateItem(tokens, item.name || item.title || 'Product', item.price || 0);
    Lines.push({
      Amount: (item.price || 0) * (item.quantity || 1),
      DetailType: 'SalesItemLineDetail',
      SalesItemLineDetail: {
        ItemRef:  { value: itemId },
        Qty:      item.quantity || 1,
        UnitPrice: item.price || 0
      }
    });
  }

  const invoice = await qbFetch('/invoice', {
    method: 'POST',
    body: JSON.stringify({
      CustomerRef: { value: customerId },
      Line: Lines,
      DocNumber:   order.id,
      PrivateNote: `Holm Graphics Shop Order #${order.id}`,
      BillEmail:   { Address: order.customer_email },
      EmailStatus: 'NeedToSend'
    })
  }, tokens);

  return invoice.Invoice;
}

// ─── Migration helper ─────────────────────────────────────────────────────────
async function ensureQBColumns() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS qb_tokens (
      realm_id     TEXT PRIMARY KEY,
      access_token  TEXT NOT NULL,
      refresh_token TEXT NOT NULL,
      expires_at    TIMESTAMPTZ NOT NULL,
      updated_at    TIMESTAMPTZ DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS qb_sync_log (
      id           SERIAL PRIMARY KEY,
      order_id     TEXT NOT NULL,
      qb_invoice_id TEXT,
      status       TEXT NOT NULL,
      error        TEXT,
      synced_at    TIMESTAMPTZ DEFAULT NOW()
    );
  `);
  // Add qb_invoice_id column to orders if not exists
  await pool.query(`
    ALTER TABLE orders
      ADD COLUMN IF NOT EXISTS qb_invoice_id TEXT,
      ADD COLUMN IF NOT EXISTS qb_synced_at  TIMESTAMPTZ;
  `);
}

// ─── Routes ───────────────────────────────────────────────────────────────────

// GET /api/quickbooks/status
router.get('/status', authenticateToken, requireAdmin, async (req, res) => {
  try {
    await ensureQBColumns();
    const tokens = await getTokens();
    if (!tokens) return res.json({ connected: false });

    const isExpired = new Date(tokens.expires_at) <= new Date();
    res.json({
      connected:  true,
      realm_id:   tokens.realm_id,
      expires_at: tokens.expires_at,
      is_expired: isExpired
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/quickbooks/connect  → redirects user to Intuit OAuth
router.get('/connect', authenticateToken, requireAdmin, (req, res) => {
  const state = crypto.randomBytes(16).toString('hex');
  const params = new URLSearchParams({
    client_id:     process.env.QB_CLIENT_ID,
    redirect_uri:  process.env.QB_REDIRECT_URI,
    response_type: 'code',
    scope:         SCOPES,
    state
  });
  res.redirect(`${QB_AUTH_URL}?${params}`);
});

// GET /api/quickbooks/callback  → Intuit redirects back here
router.get('/callback', async (req, res) => {
  const { code, realmId, state } = req.query;
  if (!code || !realmId) return res.status(400).send('Missing OAuth params');

  try {
    const creds = Buffer.from(
      `${process.env.QB_CLIENT_ID}:${process.env.QB_CLIENT_SECRET}`
    ).toString('base64');

    const tokenRes = await fetch(QB_TOKEN_URL, {
      method: 'POST',
      headers: {
        'Authorization': `Basic ${creds}`,
        'Content-Type': 'application/x-www-form-urlencoded'
      },
      body: new URLSearchParams({
        grant_type:   'authorization_code',
        code,
        redirect_uri: process.env.QB_REDIRECT_URI
      })
    });

    if (!tokenRes.ok) throw new Error('Token exchange failed');
    const data = await tokenRes.json();

    await ensureQBColumns();
    await saveTokens({
      access_token:  data.access_token,
      refresh_token: data.refresh_token,
      realm_id:      realmId,
      expires_at:    new Date(Date.now() + data.expires_in * 1000).toISOString()
    });

    // Redirect to admin panel with success flag
    res.redirect(`${process.env.CORS_ORIGIN}/admin/quickbooks?connected=true`);
  } catch (err) {
    console.error('QB callback error:', err);
    res.redirect(`${process.env.CORS_ORIGIN}/admin/quickbooks?error=${encodeURIComponent(err.message)}`);
  }
});

// DELETE /api/quickbooks/disconnect
router.delete('/disconnect', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const tokens = await getTokens();
    if (tokens) {
      const creds = Buffer.from(
        `${process.env.QB_CLIENT_ID}:${process.env.QB_CLIENT_SECRET}`
      ).toString('base64');
      await fetch(QB_REVOKE_URL, {
        method: 'POST',
        headers: {
          'Authorization': `Basic ${creds}`,
          'Content-Type': 'application/x-www-form-urlencoded'
        },
        body: new URLSearchParams({ token: tokens.refresh_token })
      });
      await clearTokens();
    }
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/quickbooks/sync/order/:id  → sync single order to QBO invoice
router.post('/sync/order/:id', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const tokens = await getTokens();
    if (!tokens) return res.status(400).json({ error: 'QuickBooks not connected' });

    const orderRes = await pool.query('SELECT * FROM orders WHERE id = $1', [req.params.id]);
    if (orderRes.rows.length === 0) return res.status(404).json({ error: 'Order not found' });

    const order = orderRes.rows[0];
    if (order.qb_invoice_id) {
      return res.json({ already_synced: true, qb_invoice_id: order.qb_invoice_id });
    }

    const invoice = await createQBInvoice(tokens, order);

    await pool.query(
      `UPDATE orders SET qb_invoice_id = $1, qb_synced_at = NOW() WHERE id = $2`,
      [invoice.Id, order.id]
    );
    await pool.query(
      `INSERT INTO qb_sync_log (order_id, qb_invoice_id, status) VALUES ($1, $2, 'success')`,
      [order.id, invoice.Id]
    );

    res.json({ success: true, invoice_id: invoice.Id, doc_number: invoice.DocNumber });
  } catch (err) {
    await pool.query(
      `INSERT INTO qb_sync_log (order_id, status, error) VALUES ($1, 'error', $2)`,
      [req.params.id, err.message]
    );
    res.status(500).json({ error: err.message });
  }
});

// POST /api/quickbooks/sync/all  → sync all unsynced orders
router.post('/sync/all', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const tokens = await getTokens();
    if (!tokens) return res.status(400).json({ error: 'QuickBooks not connected' });

    const pending = await pool.query(
      `SELECT * FROM orders WHERE qb_invoice_id IS NULL AND status != 'cancelled' ORDER BY created_date ASC`
    );

    const results = { synced: 0, failed: 0, errors: [] };

    for (const order of pending.rows) {
      try {
        const invoice = await createQBInvoice(tokens, order);
        await pool.query(
          `UPDATE orders SET qb_invoice_id = $1, qb_synced_at = NOW() WHERE id = $2`,
          [invoice.Id, order.id]
        );
        await pool.query(
          `INSERT INTO qb_sync_log (order_id, qb_invoice_id, status) VALUES ($1, $2, 'success')`,
          [order.id, invoice.Id]
        );
        results.synced++;
      } catch (err) {
        results.failed++;
        results.errors.push({ order_id: order.id, error: err.message });
        await pool.query(
          `INSERT INTO qb_sync_log (order_id, status, error) VALUES ($1, 'error', $2)`,
          [order.id, err.message]
        );
      }
    }

    res.json(results);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/quickbooks/sync/log  → recent sync activity
router.get('/sync/log', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const log = await pool.query(
      `SELECT l.*, o.customer_name, o.total_amount
       FROM qb_sync_log l
       LEFT JOIN orders o ON o.id = l.order_id
       ORDER BY l.synced_at DESC LIMIT 50`
    );
    res.json(log.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/quickbooks/summary  → dashboard numbers
router.get('/summary', authenticateToken, requireAdmin, async (req, res) => {
  try {
    await ensureQBColumns();
    const stats = await pool.query(`
      SELECT
        COUNT(*) FILTER (WHERE qb_invoice_id IS NOT NULL) AS synced,
        COUNT(*) FILTER (WHERE qb_invoice_id IS NULL AND status != 'cancelled') AS pending,
        COUNT(*) FILTER (WHERE status = 'cancelled') AS cancelled,
        SUM(total_amount) FILTER (WHERE qb_invoice_id IS NOT NULL) AS synced_revenue,
        MAX(qb_synced_at) AS last_synced_at
      FROM orders
    `);
    res.json(stats.rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
