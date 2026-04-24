// routes/quickbooks.js
// QuickBooks Online integration. Ported from the qb-work-preserve branch
// onto the Railway pg foundation: table names lowercased, mssql `dbQuery`
// helper replaced with our pg `query`, `CAST(... AS NVARCHAR)` dropped.
//
// OAuth tokens are persisted to the `qbo_tokens` table (migration 007), so
// they survive Railway redeploys. Refresh-on-demand: tokens that are within
// 60 s of expiry are refreshed before the next API call and the new pair is
// written back to DB.
//
// SCOPES includes both `accounting` (for invoices/customers/items) and
// `payment` (for QB Payments — used by the DTF online store to charge
// customer cards inline at checkout). After deploying this change, a one-
// time re-click of /api/quickbooks/connect is required so the QBO consent
// screen grants the new payment scope. The connect flow detects when the
// stored scope is narrower than what's requested and re-prompts.
//
// All routes are currently public (no auth). The frontend calls them from
// the admin-quickbooks.html page. TODO: gate the mutating routes behind
// requireAdmin once the admin UI sends its JWT.

const express = require('express');
const crypto  = require('crypto');
const { query, queryOne } = require('../db/connection');
const {
  REQUIRED_SCOPES: SCOPES,
  QB_TOKEN_URL,
  getTokens, saveTokens, clearTokens,
  hasRequiredScopes, refreshAccessToken, activeTokens,
} = require('../lib/qbo-tokens');

const router = express.Router();

// ─── QB endpoints ────────────────────────────────────────────────────────────
const QB_AUTH_URL   = 'https://appcenter.intuit.com/connect/oauth2';
const QB_REVOKE_URL = 'https://developer.api.intuit.com/v2/oauth2/tokens/revoke';

function QB_BASE() {
  // NODE_ENV=production hits real QB; anything else hits sandbox.
  return process.env.NODE_ENV === 'production'
    ? 'https://quickbooks.api.intuit.com'
    : 'https://sandbox-quickbooks.api.intuit.com';
}

// Sanitize an email before sending to QB. Strips trailing `#mailto:...`
// artefacts from legacy Outlook-paste imports, surrounding `<...>`, and
// whitespace. Returns '' if the cleaned value doesn't look like an email,
// which tells callers to omit the field entirely (QB prefers no email
// over a bad one — a bad one returns a 400 ValidationFault).
function cleanEmail(raw) {
  if (!raw) return '';
  let s = String(raw).trim();
  // Drop everything from the first `#` onward (handles foo@bar.com#mailto:foo@bar.com#).
  const hash = s.indexOf('#');
  if (hash >= 0) s = s.slice(0, hash).trim();
  // Strip wrapping angle brackets.
  s = s.replace(/^<|>$/g, '').trim();
  // Minimal sanity check: one @, at least one dot after it, no spaces.
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s)) return '';
  return s;
}

// Token management (getTokens/saveTokens/refresh/activeTokens) lives in
// lib/qbo-tokens.js so it can be reused by the QB Payments client without
// circular imports. Imported above.

// ─── QB HTTP helpers ─────────────────────────────────────────────────────────
async function qbGet(path) {
  const t = await activeTokens();
  const res = await fetch(`${QB_BASE()}/v3/company/${t.realm_id}${path}`, {
    headers: {
      'Authorization': `Bearer ${t.access_token}`,
      'Accept': 'application/json',
    },
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
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`QB API ${res.status}: ${await res.text()}`);
  return res.json();
}

// ─── PO# custom-field discovery ──────────────────────────────────────────────
// QBO Online does NOT have a top-level PONumber on the Invoice entity (that
// was QB Desktop). The "P.O. Number" field visible on the invoice entry
// form and template is a *custom field* — QBO gives each company 3 custom
// slots (DefinitionId 1/2/3) that the admin names. On this tenant slot 1
// is labelled "P.O. Number" (see the "CUSTOM-1" placeholder on the
// template customiser).
//
// We look up the DefinitionId dynamically from /preferences so this
// survives if the slots get reshuffled later. Cached in-process — a
// process bounce refreshes it. If the lookup fails we fall back to
// slot "1" with Name "P.O. Number", which matches what the UI shows today.

// undefined = never checked, null = checked and not found, string = id
let poCustomFieldIdCache;

async function getPoCustomFieldId() {
  if (poCustomFieldIdCache !== undefined) return poCustomFieldIdCache;
  try {
    const prefs = await qbGet('/preferences');
    // SalesFormsPrefs.CustomField is an array of entries like:
    //   { Name: 'SalesFormsPrefs.UseSalesCustom1',  BooleanValue: true  }
    //   { Name: 'SalesFormsPrefs.SalesCustomName1', StringValue: 'P.O. Number' }
    // Slot number is the trailing digit in Name.
    const fields = prefs?.Preferences?.SalesFormsPrefs?.CustomField || [];
    for (const f of fields) {
      if (!/SalesCustomName\d/.test(f.Name || '')) continue;
      const label = f.StringValue || '';
      if (/p\.?o\.?\s*(number|#)?|purchase\s*order/i.test(label)) {
        const slot = (f.Name.match(/(\d)$/) || [])[1];
        if (slot) {
          poCustomFieldIdCache = slot;
          return slot;
        }
      }
    }
    poCustomFieldIdCache = null;
    return null;
  } catch (e) {
    // Don't cache failures — transient token/network issues shouldn't
    // permanently break PO# export for this process.
    console.warn('QB preferences lookup failed:', e.message);
    return null;
  }
}

// ═════════════════════════════════════════════════════════════════════════════
// AUTH ROUTES
// ═════════════════════════════════════════════════════════════════════════════

// GET /api/quickbooks/status
router.get('/status', async (req, res) => {
  try {
    const tokens = await getTokens();
    if (!tokens) return res.json({ connected: false });
    res.json({
      connected:        true,
      realm_id:         tokens.realm_id,
      expires_at:       tokens.expires_at,
      is_expired:       new Date(tokens.expires_at) <= new Date(),
      scopes:           tokens.scopes,
      // True if our requested SCOPES are a subset of what's stored. False
      // means the user needs to re-click /connect to grant the additional
      // scope (e.g. com.intuit.quickbooks.payment).
      scopes_complete:  hasRequiredScopes(tokens.scopes),
      required_scopes:  SCOPES,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/quickbooks/connect  — redirects user to Intuit for consent
router.get('/connect', (req, res) => {
  const params = new URLSearchParams({
    client_id:     process.env.QB_CLIENT_ID,
    redirect_uri:  process.env.QB_REDIRECT_URI,
    response_type: 'code',
    scope:         SCOPES,
    state:         crypto.randomBytes(16).toString('hex'),
  });
  res.redirect(`${QB_AUTH_URL}?${params}`);
});

// GET /api/quickbooks/callback  — Intuit redirects here after consent
router.get('/callback', async (req, res) => {
  const { code, realmId } = req.query;
  if (!code || !realmId) return res.status(400).send('Missing OAuth params');
  try {
    const creds = Buffer.from(
      `${process.env.QB_CLIENT_ID}:${process.env.QB_CLIENT_SECRET}`
    ).toString('base64');
    const tokenRes = await fetch(QB_TOKEN_URL, {
      method: 'POST',
      headers: {
        'Authorization': `Basic ${creds}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams({
        grant_type:   'authorization_code',
        code,
        redirect_uri: process.env.QB_REDIRECT_URI,
      }),
    });
    if (!tokenRes.ok) throw new Error('Token exchange failed');
    const data = await tokenRes.json();
    // Intuit doesn't return granted scopes on the token response, so we
    // record what we asked for. The consent screen guarantees the user
    // saw and agreed to all of SCOPES, otherwise the callback wouldn't fire.
    await saveTokens({
      realm_id:      realmId,
      access_token:  data.access_token,
      refresh_token: data.refresh_token,
      expires_at:    new Date(Date.now() + data.expires_in * 1000).toISOString(),
      scopes:        SCOPES,
    });
    const base = process.env.CORS_ORIGINS?.split(',')[0] || 'https://holmgraphics.ca';
    res.redirect(`${base}/admin-quickbooks.html?connected=true`);
  } catch (err) {
    const base = process.env.CORS_ORIGINS?.split(',')[0] || 'https://holmgraphics.ca';
    res.redirect(`${base}/admin-quickbooks.html?error=${encodeURIComponent(err.message)}`);
  }
});

// DELETE /api/quickbooks/disconnect  — revoke + clear stored tokens
router.delete('/disconnect', async (req, res) => {
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
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: new URLSearchParams({ token: tokens.refresh_token }),
      });
      await clearTokens();
    }
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ═════════════════════════════════════════════════════════════════════════════
// DASHBOARD / SUMMARY
// ═════════════════════════════════════════════════════════════════════════════

// GET /api/quickbooks/summary
router.get('/summary', async (req, res) => {
  try {
    const rows = await query(`
      SELECT
        SUM(CASE WHEN qb_customer_id IS NOT NULL THEN 1 ELSE 0 END) AS synced,
        SUM(CASE WHEN qb_customer_id IS NULL THEN 1 ELSE 0 END) AS pending,
        0 AS cancelled,
        0 AS synced_revenue,
        NULL AS last_synced_at
      FROM clients
    `);
    res.json(rows[0]);
  } catch {
    res.json({ synced: 0, pending: 0, cancelled: 0, synced_revenue: 0, last_synced_at: null });
  }
});

// GET /api/quickbooks/sync/log  — placeholder
router.get('/sync/log', (req, res) => res.json([]));

// POST /api/quickbooks/sync/all  — placeholder, directs to /clients/push
router.post('/sync/all', (req, res) => {
  res.json({ synced: 0, failed: 0, errors: [], message: 'Use /clients/push to sync clients' });
});

// GET /api/quickbooks/taxcodes  — diagnostic
router.get('/taxcodes', async (req, res) => {
  try {
    const data = await qbGet(`/query?query=${encodeURIComponent('SELECT * FROM TaxCode')}`);
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ═════════════════════════════════════════════════════════════════════════════
// INVOICE
// ═════════════════════════════════════════════════════════════════════════════

// POST /api/quickbooks/invoice/project/:id
router.post('/invoice/project/:id', async (req, res) => {
  try {
    const { client_name, description, items, project_number } = req.body;
    const client_email = cleanEmail(req.body.client_email);
    // Customer-supplied PO#. Optional. Rendered on the printed/emailed
    // invoice via CustomerMemo and stashed in PrivateNote for internal
    // search. QBO Online has no dedicated PONumber field on Invoice (that
    // was QB Desktop); the "P.O. Number" field on the QBO invoice screen
    // is a company-configured custom field we can't rely on being there.
    const po_number = (req.body.po_number || '').toString().trim();
    if (!client_name || !items?.length) {
      return res.status(400).json({ error: 'client_name and items are required' });
    }

    // Find or create QB customer.
    const searchData = await qbGet(
      `/query?query=${encodeURIComponent(
        `SELECT * FROM Customer WHERE DisplayName = '${client_name.replace(/'/g, "\\'")}' MAXRESULTS 1`
      )}`
    );
    let customerId = searchData?.QueryResponse?.Customer?.[0]?.Id;

    if (!customerId) {
      const newCust = await qbPost('/customer', {
        DisplayName: client_name,
        ...(client_email ? { PrimaryEmailAddr: { Address: client_email } } : {}),
      });
      customerId = newCust?.Customer?.Id;
      if (!customerId) throw new Error('Failed to create QB customer');
    }

    // Look up the 'Misc' fallback item.
    const itemSearch = await qbGet(
      `/query?query=${encodeURIComponent(`SELECT * FROM Item WHERE Name = 'Misc' MAXRESULTS 1`)}`
    );
    const miscItemId = itemSearch?.QueryResponse?.Item?.[0]?.Id || '1';

    // Build Line array — look up each item's QB item ID by name.
    const Line = await Promise.all(items.map(async (item) => {
      let itemId = miscItemId;
      if (item.qb_item_name) {
        // QB stores categories in the Item table alongside products. If a
        // category shares the name of an invoiceable item (e.g. "Vehicles"),
        // picking the category causes "Invalid Reference Id" (code 2500).
        // QBQL doesn't support Type != 'Category' (code 2090), so fetch all
        // matches and filter client-side.
        const s = await qbGet(
          `/query?query=${encodeURIComponent(
            `SELECT * FROM Item WHERE Name = '${item.qb_item_name.replace(/'/g, "\\'")}'`
          )}`
        );
        const hits = s?.QueryResponse?.Item || [];
        const product = hits.find((i) => i.Type !== 'Category') || null;
        itemId = product?.Id || miscItemId;
      }
      return {
        Amount:      parseFloat(item.total),
        DetailType:  'SalesItemLineDetail',
        Description: item.description || '',
        SalesItemLineDetail: {
          ItemRef:    { value: itemId },
          UnitPrice:  parseFloat(item.unit_price),
          Qty:        parseFloat(item.qty),
          TaxCodeRef: { value: '7' },
        },
      };
    }));

    // Create the invoice.
    const privateNote = po_number
      ? `Holm Graphics Project #${project_number || req.params.id} — Customer PO# ${po_number}`
      : `Holm Graphics Project #${project_number || req.params.id}`;

    // Discover the company-configured P.O. Number custom-field slot. Fall
    // back to slot "1" which is what this tenant uses today (the invoice
    // template customiser shows "CUSTOM-1" as the P.O. Number placeholder).
    let poField = null;
    if (po_number) {
      const defId = (await getPoCustomFieldId()) || '1';
      poField = {
        DefinitionId: defId,
        Name:         'P.O. Number',
        Type:         'StringType',
        StringValue:  po_number,
      };
    }

    const invData = await qbPost('/invoice?minorversion=65', {
      CustomerRef: { value: customerId },
      DocNumber:   String(project_number || req.params.id),
      PrivateNote: privateNote,
      Line,
      TxnTaxDetail: {
        TxnTaxCodeRef: { value: '7' },
        TotalTax: 0,
      },
      // Native "P.O. Number" field on the invoice — QBO stores it as a
      // custom field entry keyed by DefinitionId.
      ...(poField ? { CustomField: [poField] } : {}),
      ...(client_email
        ? { BillEmail: { Address: client_email }, EmailStatus: 'NeedToSend' }
        : {}),
    });

    const invoice = invData.Invoice;
    res.json({
      success:    true,
      invoice_id: invoice.Id,
      doc_number: invoice.DocNumber,
      total:      invoice.TotalAmt,
      message:    `Invoice #${invoice.DocNumber} created in QuickBooks`,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ═════════════════════════════════════════════════════════════════════════════
// CLIENT SYNC
// ═════════════════════════════════════════════════════════════════════════════

// GET /api/quickbooks/clients/status
router.get('/clients/status', async (req, res) => {
  try {
    const rows = await query(`
      SELECT
        COUNT(*) AS total,
        COUNT(qb_customer_id) AS synced_to_qb,
        COUNT(*) - COUNT(qb_customer_id) AS not_in_qb
      FROM clients
    `);
    res.json(rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/quickbooks/clients/list
router.get('/clients/list', async (req, res) => {
  try {
    const rows = await query(`
      SELECT id, company, fname, lname, email, qb_customer_id
      FROM clients
      ORDER BY company ASC, lname ASC
    `);
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/quickbooks/clients/search?q=term  — direct QB customer search
router.get('/clients/search', async (req, res) => {
  try {
    const q = (req.query.q || '').replace(/'/g, "\\'");
    if (!q) return res.json([]);
    const data = await qbGet(
      `/query?query=${encodeURIComponent(
        `SELECT * FROM Customer WHERE DisplayName LIKE '%${q}%' MAXRESULTS 20`
      )}`
    );
    res.json(data?.QueryResponse?.Customer || []);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/quickbooks/clients/qb-list  — paginated dump of all active QB customers
router.get('/clients/qb-list', async (req, res) => {
  try {
    let allCustomers = [];
    let startPos = 1;
    const pageSize = 100;
    let hasMore = true;
    while (hasMore) {
      const data = await qbGet(
        `/query?query=${encodeURIComponent(
          `SELECT * FROM Customer WHERE Active = true STARTPOSITION ${startPos} MAXRESULTS ${pageSize}`
        )}`
      );
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

// POST /api/quickbooks/clients/push  — push all unsynced local clients to QB
router.post('/clients/push', async (req, res) => {
  try {
    const unsynced = await query(`SELECT * FROM clients WHERE qb_customer_id IS NULL`);
    const results = { pushed: 0, failed: 0, errors: [] };

    for (const client of unsynced) {
      try {
        const email = cleanEmail(client.email);
        const displayName = client.company ||
          [client.fname, client.lname].filter(Boolean).join(' ') ||
          email || `Client #${client.id}`;

        const searchData = await qbGet(
          `/query?query=${encodeURIComponent(
            `SELECT * FROM Customer WHERE DisplayName = '${displayName.replace(/'/g, "\\'")}' MAXRESULTS 1`
          )}`
        );
        let qbId = searchData?.QueryResponse?.Customer?.[0]?.Id;

        if (!qbId) {
          const created = await qbPost('/customer', {
            DisplayName: displayName,
            ...(client.fname ? { GivenName: client.fname } : {}),
            ...(client.lname ? { FamilyName: client.lname } : {}),
            ...(email ? { PrimaryEmailAddr: { Address: email } } : {}),
          });
          qbId = created?.Customer?.Id;
        }

        if (qbId) {
          await query(`UPDATE clients SET qb_customer_id = $1 WHERE id = $2`, [qbId, client.id]);
          results.pushed++;
        }
      } catch (err) {
        results.failed++;
        results.errors.push({ client_id: client.id, error: err.message });
      }
    }
    res.json(results);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/quickbooks/clients/push/:id  — push a single client to QB
router.post('/clients/push/:id', async (req, res) => {
  try {
    const clients = await query(`SELECT * FROM clients WHERE id = $1`, [req.params.id]);
    if (!clients.length) return res.status(404).json({ error: 'Client not found' });
    const client = clients[0];
    if (client.qb_customer_id) {
      return res.json({ already_synced: true, qb_customer_id: client.qb_customer_id });
    }

    const email = cleanEmail(client.email);
    const displayName = client.company ||
      [client.fname, client.lname].filter(Boolean).join(' ') ||
      email || `Client #${client.id}`;

    const created = await qbPost('/customer', {
      DisplayName: displayName,
      ...(client.fname ? { GivenName: client.fname } : {}),
      ...(client.lname ? { FamilyName: client.lname } : {}),
      ...(email ? { PrimaryEmailAddr: { Address: email } } : {}),
    });
    const qbId = created?.Customer?.Id;
    if (qbId) await query(`UPDATE clients SET qb_customer_id = $1 WHERE id = $2`, [qbId, client.id]);
    res.json({ success: true, qb_customer_id: qbId, display_name: displayName });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
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
        `/query?query=${encodeURIComponent(
          `SELECT * FROM Customer WHERE Active = true STARTPOSITION ${startPos} MAXRESULTS ${pageSize}`
        )}`
      );
      const customers = data?.QueryResponse?.Customer || [];
      if (!customers.length) { hasMore = false; break; }

      for (const cust of customers) {
        try {
          const existing = await query(
            `SELECT id FROM clients WHERE qb_customer_id = $1`, [cust.Id]
          );
          if (existing.length) { results.skipped++; continue; }

          const email = cust.PrimaryEmailAddr?.Address || null;
          if (email) {
            const byEmail = await query(
              `SELECT id FROM clients WHERE email = $1 AND qb_customer_id IS NULL`, [email]
            );
            if (byEmail.length) {
              await query(
                `UPDATE clients SET qb_customer_id = $1 WHERE id = $2`,
                [cust.Id, byEmail[0].id]
              );
              results.updated++;
              continue;
            }
          }

          await query(
            `INSERT INTO clients (company, fname, lname, email, qb_customer_id) VALUES ($1, $2, $3, $4, $5)`,
            [
              cust.CompanyName || cust.DisplayName || '',
              cust.GivenName  || '',
              cust.FamilyName || '',
              email,
              cust.Id,
            ]
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
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/quickbooks/clients/link  — manually link a client to a QB customer
router.post('/clients/link', async (req, res) => {
  try {
    const { client_id, qb_customer_id } = req.body;
    if (!client_id || !qb_customer_id) {
      return res.status(400).json({ error: 'client_id and qb_customer_id are required' });
    }
    const clients = await query(`SELECT id FROM clients WHERE id = $1`, [client_id]);
    if (!clients.length) return res.status(404).json({ error: 'Client not found' });
    await query(
      `UPDATE clients SET qb_customer_id = $1 WHERE id = $2`,
      [qb_customer_id, client_id]
    );
    res.json({ success: true, client_id, qb_customer_id });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
