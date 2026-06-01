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
const { requireAdmin } = require('../middleware/auth');
const {
  REQUIRED_SCOPES: SCOPES,
  QB_TOKEN_URL,
  getTokens, saveTokens, clearTokens,
  hasRequiredScopes, refreshAccessToken, activeTokens,
} = require('../lib/qbo-tokens');
// HTTP helpers + email sanitizer + QB_BASE live in lib/qbo-sync.js so this
// route, lib/qb-payments.js, and lib/qbo-sync.js itself all use the same
// implementation. Don't redefine them here.
const {
  QB_BASE, qbGet, qbPost, cleanEmail,
  findOrCreateQboCustomer,
} = require('../lib/qbo-sync');

const router = express.Router();

// ─── QB endpoints ────────────────────────────────────────────────────────────
const QB_AUTH_URL   = 'https://appcenter.intuit.com/connect/oauth2';
const QB_REVOKE_URL = 'https://developer.api.intuit.com/v2/oauth2/tokens/revoke';

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
    // QB admin lives on the staff subdomain. Path moved from
    // /admin-quickbooks.html (old standalone marketing repo) to
    // /admin-legacy/quickbooks.html when the marketing site folded
    // into the SvelteKit project.
    const base = process.env.STAFF_APP_URL || 'https://shop.holmgraphics.ca';
    res.redirect(`${base}/admin-legacy/quickbooks.html?connected=true`);
  } catch (err) {
    const base = process.env.STAFF_APP_URL || 'https://shop.holmgraphics.ca';
    res.redirect(`${base}/admin-legacy/quickbooks.html?error=${encodeURIComponent(err.message)}`);
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
    // BillEmail priority: form input wins (staff just typed it on the
    // billing screen), then any per-order notification_email captured
    // at checkout for the linked online order, then clients.email.
    // Empty at every level => leave BillEmail unset and QB falls back to
    // whatever's already on the existing Customer record.
    const projectId = parseInt(req.params.id, 10);
    const ctxRow = Number.isInteger(projectId)
      ? await queryOne(
          `SELECT c.email AS client_email, o.notification_email
             FROM projects p
             LEFT JOIN clients c ON c.id = p.client_id
             LEFT JOIN orders   o ON o.job_id = p.id AND o.notification_email IS NOT NULL
            WHERE p.id = $1
            ORDER BY o.id DESC NULLS LAST
            LIMIT 1`,
          [projectId]
        )
      : null;
    const billEmail =
      cleanEmail(req.body.client_email) ||
      cleanEmail(ctxRow?.notification_email) ||
      cleanEmail(ctxRow?.client_email) ||
      '';
    // Customer-supplied PO#. Optional. Rendered on the printed/emailed
    // invoice via CustomerMemo and stashed in PrivateNote for internal
    // search. QBO Online has no dedicated PONumber field on Invoice (that
    // was QB Desktop); the "P.O. Number" field on the QBO invoice screen
    // is a company-configured custom field we can't rely on being there.
    const po_number = (req.body.po_number || '').toString().trim();
    if (!client_name || !items?.length) {
      return res.status(400).json({ error: 'client_name and items are required' });
    }

    // Find or create QB customer via the shared helper. Survives the
    // 6240 (Duplicate Name Exists) trap that fires when the local
    // client_name omits a suffix QB has on its record (e.g. local says
    // "Holm Graphics", QB says "Holm Graphics Inc"). See lib/qbo-sync.js
    // findOrCreateQboCustomer for the full fallback flow.
    const customer = await findOrCreateQboCustomer({
      displayName: client_name,
      email:       billEmail,
    });
    const customerId = customer.Id;
    if (!customerId) throw new Error('Failed to resolve QB customer Id');

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
      ...(billEmail
        ? { BillEmail: { Address: billEmail }, EmailStatus: 'NeedToSend' }
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

// ─── GET /api/quickbooks/employees ───────────────────────────────────────────
// Fetch the list of active QBO Employee records from the connected company.
// Used by the /admin/qbo-employees mapping page to populate the dropdowns.
//
// Returns: [{ id, given_name, family_name, display_name, primary_email,
//             active }]
//
// QBO's Employee object docs: developer.intuit.com/docs/api/accounting/Employee
router.get('/employees', async (req, res) => {
  try {
    const data = await qbGet(
      `/query?query=${encodeURIComponent(
        `SELECT * FROM Employee WHERE Active = true MAXRESULTS 200`
      )}`
    );
    const list = (data?.QueryResponse?.Employee || []).map(e => ({
      id:             e.Id,
      given_name:     e.GivenName     || null,
      family_name:    e.FamilyName    || null,
      display_name:   e.DisplayName   || null,
      primary_email:  e.PrimaryEmailAddr?.Address || null,
      active:         e.Active !== false,
    }));
    res.json(list);
  } catch (err) {
    console.error('GET /api/quickbooks/employees failed:', err);
    res.status(500).json({ error: err.message, detail: err.qbDetail || null });
  }
});

// ─── Lunch deduction (mirror of routes/time.js logic) ────────────────────────
// Per-day total > 4h ⇒ -30 min, deducted from the longest entry, cascading.
// Duplicated here (rather than imported from routes/time.js) so this file
// has no cross-route deps. Keep the constants and date-key formatter in
// sync if the policy changes there.
const LUNCH_THRESHOLD_MIN = 240;
const LUNCH_DEDUCTION_MIN = 30;
const SHOP_TZ = 'America/Toronto';
const _LUNCH_DATE_FMT = new Intl.DateTimeFormat('en-CA', {
  timeZone: SHOP_TZ, year: 'numeric', month: '2-digit', day: '2-digit',
});
function _localDateKey(iso) { return _LUNCH_DATE_FMT.format(new Date(iso)); }
function _computeLunchDeductions(rows) {
  const groups = new Map();
  for (const r of rows) {
    if (!r.clock_out) continue;
    const minutes = Math.round((new Date(r.clock_out) - new Date(r.clock_in)) / 60000);
    if (minutes <= 0) continue;
    const key = `${r.employee_id}:${_localDateKey(r.clock_in)}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push({ id: r.id, minutes });
  }
  const deductions = new Map();
  for (const dayEntries of groups.values()) {
    const total = dayEntries.reduce((s, e) => s + e.minutes, 0);
    if (total <= LUNCH_THRESHOLD_MIN) continue;
    const sorted = [...dayEntries].sort((a, b) => b.minutes - a.minutes);
    let remaining = LUNCH_DEDUCTION_MIN;
    for (const e of sorted) {
      if (remaining <= 0) break;
      const take = Math.min(e.minutes, remaining);
      if (take > 0) {
        deductions.set(e.id, (deductions.get(e.id) || 0) + take);
        remaining -= take;
      }
    }
  }
  return deductions;
}

// ─── POST /api/quickbooks/sync-time-period/:id ───────────────────────────────
// Push a pay period's time entries to QBO as TimeActivity records.
//
// For each entry that's status closed/approved AND not already synced
// (qbo_time_activity_id IS NULL):
//   - Skip if the employee isn't yet mapped (employees.qbo_employee_id IS NULL)
//   - Build a TimeActivity payload from the PAID minutes (post-lunch-deduction)
//   - POST to /v3/.../timeactivity
//   - On success: store qbo_time_activity_id + qbo_synced_at, flip status='exported'
//
// Idempotent: re-running skips already-synced entries via qbo_time_activity_id.
//
// Billable mapping:
//   - If the entry has a project AND that project's client has a qb_customer_id,
//     mark BillableStatus='Billable' with CustomerRef pointed at the QBO customer.
//   - Otherwise NotBillable.
//
// Response:
//   {
//     synced:               int,
//     skipped_no_mapping:   int,   // employee not linked to QBO
//     skipped_already_synced: int, // qbo_time_activity_id already set
//     errors: [{ entry_id, employee_name, message, qbCode }],
//   }
//
// On a fully-successful run, the pay_periods row is also flipped to
// status='exported' with audit metadata. Partial runs leave the period
// status alone so the admin can re-run after fixing the missing pieces.
router.post('/sync-time-period/:id', requireAdmin, async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!Number.isInteger(id)) {
    return res.status(400).json({ message: 'invalid pay period id' });
  }
  const payPeriod = await queryOne('SELECT * FROM pay_periods WHERE id = $1', [id]);
  if (!payPeriod) {
    return res.status(404).json({ message: 'Pay period not found.' });
  }
  // Pull all not-yet-synced entries for the period, joined with employee
  // (for qbo_employee_id and display name) and project→client (for the
  // billable customer linkage).
  let rows;
  try {
    rows = await query(
      `SELECT t.id, t.employee_id, t.clock_in, t.clock_out,
              t.notes, t.status, t.project_id,
              t.qbo_time_activity_id,
              e.qbo_employee_id,
              TRIM(CONCAT_WS(' ', e.first_name, e.last_name)) AS employee_name,
              p.description AS project_name,
              c.qb_customer_id AS qbo_customer_id
         FROM time_entries t
         LEFT JOIN employees e ON e.id = t.employee_id
         LEFT JOIN projects  p ON p.id = t.project_id
         LEFT JOIN clients   c ON c.id = p.client_id
        WHERE t.pay_period_id = $1
          AND t.clock_out IS NOT NULL
          AND t.status IN ('closed', 'approved', 'exported')
        ORDER BY t.employee_id, t.clock_in`,
      [id]
    );
  } catch (e) {
    console.error('sync-time-period load failed:', e);
    return res.status(500).json({ message: 'Lookup failed', detail: e.message });
  }
  // Compute lunch deductions across the entire pay period's rows so
  // cross-day grouping is correct (and matches what /me & /admin show).
  const deductions = _computeLunchDeductions(rows);

  // Pre-check: reject the entire sync if ANY entry has an unmapped employee.
  // This prevents partial syncs and makes it clear what needs to be fixed.
  const unmappedEntries = rows.filter(r => !r.qbo_employee_id && !r.qbo_time_activity_id);
  if (unmappedEntries.length > 0) {
    return res.status(409).json({
      message: 'Cannot sync: unmapped employees detected. Run the QBO employee matcher first.',
      unmapped_employees: Array.from(new Set(unmappedEntries.map(e => e.employee_name))),
      action: 'Visit /admin-legacy/qbo-match-employees to link employees to QuickBooks.',
      unmapped_count: unmappedEntries.length,
    });
  }

  let synced = 0;
  let skippedAlreadySynced = 0;
  const errors = [];

  for (const r of rows) {
    if (r.qbo_time_activity_id) {
      skippedAlreadySynced += 1;
      continue;
    }
    const clockMinutes = Math.round(
      (new Date(r.clock_out) - new Date(r.clock_in)) / 60000
    );
    const lunchMinutes = deductions.get(r.id) || 0;
    const paidMinutes  = Math.max(0, clockMinutes - lunchMinutes);
    if (paidMinutes <= 0) {
      // Don't attempt to push a 0-minute activity; skip silently.
      skippedAlreadySynced += 1;
      continue;
    }
    const hours   = Math.floor(paidMinutes / 60);
    const minutes = paidMinutes % 60;
    const txnDate = _localDateKey(r.clock_in);

    // Stitch a Description that gives payroll context — project + raw
    // clock vs paid + admin's notes if any. Capped to 1000 chars (QBO).
    const descBits = [];
    if (r.project_id) descBits.push(`Job ${r.project_id}${r.project_name ? ' - ' + r.project_name : ''}`);
    if (lunchMinutes > 0) descBits.push(`[lunch -${lunchMinutes}m]`);
    if (r.notes) descBits.push(r.notes);
    const description = descBits.join(' · ').slice(0, 1000);

    const billable = !!r.qbo_customer_id;
    const payload = {
      TxnDate: txnDate,
      NameOf:  'Employee',
      EmployeeRef: { value: r.qbo_employee_id },
      Hours:   hours,
      Minutes: minutes,
      Description: description || undefined,
      BillableStatus: billable ? 'Billable' : 'NotBillable',
    };
    if (billable) {
      payload.CustomerRef = { value: r.qbo_customer_id };
    }

    try {
      const result = await qbPost('/timeactivity?minorversion=65', payload);
      const newId = result?.TimeActivity?.Id;
      if (!newId) {
        throw new Error('QBO did not return a TimeActivity Id');
      }
      await query(
        `UPDATE time_entries
            SET qbo_time_activity_id = $1,
                qbo_synced_at = NOW(),
                status = 'exported'
          WHERE id = $2`,
        [newId, r.id]
      );
      synced += 1;
    } catch (err) {
      errors.push({
        entry_id: r.id,
        employee_name: r.employee_name,
        message: err.qbDetail || err.message || String(err),
        qbCode: err.qbCode || null,
      });
    }
  }

  // If everything succeeded (no errors and we actually pushed entries),
  // flag the period as exported with audit metadata so the next pay-cycle
  // run knows it's done.
  if (errors.length === 0 && synced > 0) {
    try {
      await query(
        `UPDATE pay_periods
            SET status = 'exported',
                exported_at = NOW(),
                exported_by = $2,
                csv_filename = $3,
                exported_count = $4
          WHERE id = $1`,
        [
          payPeriod.id,
          req.user.id,
          `qbo-timeactivity-PP-${payPeriod.start_date}-to-${payPeriod.end_date}`,
          synced,
        ]
      );
    } catch (e) {
      console.error('Failed to mark pay period exported:', e);
      // Don't fail the response — entries are synced; admin can mark
      // the period via the UI manually if this somehow blew up.
    }
  }

  res.json({
    pay_period_id: payPeriod.id,
    synced,
    skipped_already_synced: skippedAlreadySynced,
    errors,
  });
});

// ─── POST /api/quickbooks/sync-payroll/:id ──────────────────────────────────
// Push a pay period's time entries to QBO Payroll as employee hours.
//
// For each employee with entries in the period that are status closed/approved
// AND not already synced to payroll (qbo_synced_at IS NULL):
//   - Skip if the employee isn't yet mapped (employees.qbo_employee_id IS NULL)
//   - Sum up PAID minutes for the entire period
//   - Convert to decimal hours
//   - POST to QBO Payroll API endpoint
//   - On success: mark qbo_synced_at, record sync in qbo_payroll_syncs table
//
// Idempotent: re-running skips already-synced entries via qbo_synced_at.
//
// Response:
//   {
//     pay_period_id:      int,
//     synced_employees:   int,     // number of employees synced
//     synced_entries:     int,     // total time entries pushed
//     total_hours:        decimal, // sum of all synced hours
//     skipped_no_mapping: int,     // employees not linked to QBO
//     skipped_already_synced: int, // entries already synced
//     errors: [{ employee_name, entry_id, message }],
//   }
router.post('/sync-payroll/:id', requireAdmin, async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!Number.isInteger(id)) {
    return res.status(400).json({ message: 'invalid pay period id' });
  }

  const payPeriod = await queryOne('SELECT * FROM pay_periods WHERE id = $1', [id]);
  if (!payPeriod) {
    return res.status(404).json({ message: 'Pay period not found.' });
  }

  // Fetch all time entries for the period that are closed/approved and not yet synced to payroll
  let rows;
  try {
    rows = await query(
      `SELECT t.id, t.employee_id, t.clock_in, t.clock_out,
              t.notes, t.status, t.project_id,
              t.qbo_synced_at,
              e.qbo_employee_id,
              TRIM(CONCAT_WS(' ', e.first_name, e.last_name)) AS employee_name
         FROM time_entries t
         LEFT JOIN employees e ON e.id = t.employee_id
        WHERE t.pay_period_id = $1
          AND t.clock_out IS NOT NULL
          AND t.status IN ('closed', 'approved', 'exported')
        ORDER BY t.employee_id, t.clock_in`,
      [id]
    );
  } catch (e) {
    console.error('sync-payroll load failed:', e);
    return res.status(500).json({ message: 'Lookup failed', detail: e.message });
  }

  // Compute lunch deductions across all period entries
  const deductions = _computeLunchDeductions(rows);

  // Group entries by employee and sum hours
  const employeeHours = new Map();
  const processedEntries = new Map(); // Track which entries we process
  let skippedNoMapping = 0;
  let skippedAlreadySynced = 0;
  const unmappedEmployees     = new Set();   // names — for actionable error UI
  const alreadySyncedEmployees = new Set();

  for (const r of rows) {
    // Skip entries already synced to payroll
    if (r.qbo_synced_at) {
      skippedAlreadySynced++;
      if (r.employee_name) alreadySyncedEmployees.add(r.employee_name);
      continue;
    }

    // Skip employees not yet mapped to QBO
    if (!r.qbo_employee_id) {
      skippedNoMapping++;
      if (r.employee_name) unmappedEmployees.add(r.employee_name);
      continue;
    }

    // Calculate paid minutes (after lunch deduction)
    const clockMinutes = Math.round(
      (new Date(r.clock_out) - new Date(r.clock_in)) / 60000
    );
    const lunchMinutes = deductions.get(r.id) || 0;
    const paidMinutes = Math.max(0, clockMinutes - lunchMinutes);

    if (paidMinutes <= 0) {
      // Skip zero-hour entries
      skippedAlreadySynced++;
      continue;
    }

    // Convert minutes to decimal hours
    const hours = paidMinutes / 60;

    // Group by employee
    if (!employeeHours.has(r.employee_id)) {
      employeeHours.set(r.employee_id, {
        employee_id: r.employee_id,
        employee_name: r.employee_name,
        qbo_employee_id: r.qbo_employee_id,
        hours: 0,
        entries: [],
      });
    }

    const emp = employeeHours.get(r.employee_id);
    emp.hours += hours;
    emp.entries.push(r.id);
    processedEntries.set(r.id, true);
  }

  // Track sync results
  let syncedEmployees = 0;
  let syncedEntries = 0;
  let totalHours = 0;
  const errors = [];

  // Sync each employee's hours to QBO Payroll
  for (const [, empData] of employeeHours) {
    try {
      // Call QBO Payroll API to update employee hours
      // The payload structure for QBO Payroll's batch hours endpoint:
      // POST /payroll/employees/{employeeId}/timeactivity
      // or similar (exact endpoint depends on QBO Payroll API version)
      //
      // For now, we'll use a generalized approach with the TimeActivity
      // endpoint, which is compatible with QBO's payroll tracking.
      // In production, this may need to be updated based on the specific
      // payroll system being used.

      const txnDate = _localDateKey(payPeriod.start_date);
      const payload = {
        TxnDate: txnDate,
        NameOf: 'Employee',
        EmployeeRef: { value: empData.qbo_employee_id },
        Hours: Math.floor(empData.hours),
        Minutes: Math.round((empData.hours % 1) * 60),
        Description: `Payroll sync for period ${payPeriod.start_date} to ${payPeriod.end_date}`,
        BillableStatus: 'NotBillable', // Payroll hours are not billable
      };

      // POST to QBO — the TimeActivity endpoint can be used for payroll tracking
      const result = await qbPost('/timeactivity?minorversion=65', payload);
      const newId = result?.TimeActivity?.Id;
      if (!newId) {
        throw new Error('QBO did not return a TimeActivity Id');
      }

      // Mark all entries for this employee as synced to payroll
      await query(
        `UPDATE time_entries
            SET qbo_synced_at = NOW()
          WHERE id = ANY($1::int[])`,
        [empData.entries]
      );

      syncedEmployees++;
      syncedEntries += empData.entries.length;
      totalHours += empData.hours;
    } catch (err) {
      errors.push({
        employee_name: empData.employee_name,
        employee_id: empData.employee_id,
        message: err.qbDetail || err.message || String(err),
      });
    }
  }

  // Record the sync attempt in qbo_payroll_syncs table
  if (syncedEmployees > 0 || errors.length === 0) {
    try {
      await query(
        `INSERT INTO qbo_payroll_syncs
            (pay_period_id, synced_by, entry_count, status, created_at, updated_at)
         VALUES ($1, $2, $3, $4, NOW(), NOW())`,
        [
          payPeriod.id,
          req.user.id,
          syncedEntries,
          errors.length === 0 ? 'success' : 'failed',
        ]
      );
    } catch (e) {
      console.error('Failed to record payroll sync:', e);
      // Don't fail the response — entries are synced; admin can check status
    }
  }

  res.json({
    pay_period_id: payPeriod.id,
    synced_employees: syncedEmployees,
    synced_entries: syncedEntries,
    total_hours: Math.round(totalHours * 100) / 100,
    skipped_no_mapping: skippedNoMapping,
    skipped_already_synced: skippedAlreadySynced,
    unmapped_employees:      [...unmappedEmployees].sort(),
    already_synced_employees: [...alreadySyncedEmployees].sort(),
    errors,
  });
});

module.exports = router;
