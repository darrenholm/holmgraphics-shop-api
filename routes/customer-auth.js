// routes/customer-auth.js
// Authentication endpoints for online customers (the public-facing buyers
// of the DTF online store). Distinct from /api/auth/* which is staff-only.
//
// Account lifecycle:
//
//   1. Existing-customer activation flow
//      Customers already in QBO are imported into `clients` (via
//      /api/quickbooks/clients/pull) with account_status='unactivated' and
//      no password_hash. To claim their record:
//        a. /api/customer/request-activation { email }   → emails a link
//        b. /api/customer/activate/:token { password }   → sets password,
//                                                          account_status='active'
//
//   2. New customer registration
//      First-time visitors hit /api/customer/register with name + email +
//      password. We:
//        a. Check for an existing record by email — if it's unactivated,
//           transparently treat as activation (issue activation link instead
//           of registering, to prevent duplicates and confused identities).
//        b. If no existing record, INSERT a new clients row with
//           account_status='active' and email_verified_at=NULL (we send a
//           verification email asynchronously but don't block login on it).
//        c. POST a Customer to QBO and stash qb_customer_id locally.
//
//   3. Login
//      Standard email + password against clients.password_hash.
//      Returns a customer JWT + the public profile.
//
//   4. Forgot password / reset
//      /api/customer/forgot-password { email } → emails one-hour reset link
//      /api/customer/reset-password   { token, password }
//
// Email sending is delegated to a small helper in lib/customer-mailer.js
// (currently a no-op stub that logs to console — real provider wired in a
// later step).

'use strict';

const express = require('express');
const bcrypt  = require('bcryptjs');
const crypto  = require('crypto');
const { query, queryOne } = require('../db/connection');
const { signCustomerToken } = require('../lib/jwt-customer');
const { requireCustomer }   = require('../middleware/customer-auth');
const mailer = require('../lib/customer-mailer');

const router = express.Router();

// ─── helpers ─────────────────────────────────────────────────────────────────

const BCRYPT_ROUNDS = 12;
const ACTIVATION_TTL_HOURS    = 7 * 24;   // 7 days
const PASSWORD_RESET_TTL_HOURS = 1;

function urlSafeToken(bytes = 32) {
  return crypto.randomBytes(bytes).toString('base64url');
}

function normalizeEmail(s) {
  return String(s || '').trim().toLowerCase();
}

function isValidEmail(s) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(s || ''));
}

function isValidPassword(s) {
  return typeof s === 'string' && s.length >= 8 && s.length <= 200;
}

// Public profile snapshot we return to the client. Never include
// password_hash or any token fields.
function publicProfile(client) {
  return {
    id:                       client.id,
    email:                    client.email,
    name:                     [client.fname, client.lname].filter(Boolean).join(' ') ||
                              client.company || client.email,
    fname:                    client.fname,
    lname:                    client.lname,
    company:                  client.company,
    phone:                    client.phone,
    account_status:           client.account_status,
    email_verified:           Boolean(client.email_verified_at),
    qbo_linked:               Boolean(client.qb_customer_id),
    pricing_tier_id:          client.pricing_tier_id,
    // Net-terms billing approval. allow_invoice_checkout=TRUE means the
    // checkout page hides the card form and the order POSTs through
    // with payment_method='invoice_pending'. payment_terms_days drives
    // the due_date + the "Net X" badge in the UI. NULL terms_days means
    // pay-at-checkout (default for everyone before the staff approval).
    allow_invoice_checkout:   Boolean(client.allow_invoice_checkout),
    payment_terms_days:       client.payment_terms_days || null,
    created_at:               client.created_at,
  };
}

// Fetch a client by id (used after auth checks).
async function findClientById(id) {
  return queryOne(
    `SELECT id, email, fname, lname, company, phone, qb_customer_id,
            password_hash, account_status, activation_token, activation_sent_at,
            password_reset_token, password_reset_expires,
            pricing_tier_id, email_verified_at, last_login_at,
            payment_terms_days, allow_invoice_checkout,
            created_at, updated_at
       FROM clients WHERE id = $1`,
    [id]
  );
}

async function findClientByEmail(email) {
  return queryOne(
    `SELECT id, email, fname, lname, company, phone, qb_customer_id,
            password_hash, account_status, activation_token, activation_sent_at,
            password_reset_token, password_reset_expires,
            pricing_tier_id, email_verified_at, last_login_at,
            created_at, updated_at
       FROM clients WHERE LOWER(email) = LOWER($1) LIMIT 1`,
    [email]
  );
}

// ═════════════════════════════════════════════════════════════════════════════
// REGISTRATION
// ═════════════════════════════════════════════════════════════════════════════

// POST /api/customer/register
//   { email, password, fname, lname, company?, phone? }
router.post('/register', async (req, res) => {
  try {
    const email   = normalizeEmail(req.body.email);
    const password = req.body.password || '';
    const fname   = (req.body.fname || '').toString().trim();
    const lname   = (req.body.lname || '').toString().trim();
    const company = (req.body.company || '').toString().trim() || null;
    const phone   = (req.body.phone || '').toString().trim() || null;

    if (!isValidEmail(email))     return res.status(400).json({ message: 'Valid email required' });
    if (!isValidPassword(password)) return res.status(400).json({ message: 'Password must be 8–200 characters' });
    if (!fname && !lname && !company) {
      return res.status(400).json({ message: 'Provide at least a name or company' });
    }

    const existing = await findClientByEmail(email);

    if (existing) {
      // Existing record — two cases.
      if (existing.account_status === 'active' && existing.password_hash) {
        // Already an active customer. Don't reveal whether the email exists;
        // tell them to use forgot-password if they've forgotten.
        return res.status(409).json({
          message: 'An account with that email already exists. Sign in or reset your password.',
          code: 'email_already_registered',
        });
      }
      // Unactivated (probably from QBO import) → switch to activation flow
      // transparently. Issue an activation link instead of creating a new row.
      const token = urlSafeToken();
      await query(
        `UPDATE clients SET activation_token = $1, activation_sent_at = NOW()
          WHERE id = $2`,
        [token, existing.id]
      );
      await mailer.sendActivationEmail({ email: existing.email, token, name: fname || existing.fname || '' });
      return res.status(202).json({
        message: 'It looks like we already have you on file. We\'ve sent an activation link to your email — click it to set your password.',
        code: 'activation_required',
      });
    }

    // Brand-new customer.
    const password_hash = await bcrypt.hash(password, BCRYPT_ROUNDS);
    const inserted = await queryOne(
      `INSERT INTO clients (
         email, fname, lname, company, phone,
         password_hash, account_status
       ) VALUES ($1, $2, $3, $4, $5, $6, 'active')
       RETURNING id, email, fname, lname, company, phone, qb_customer_id,
                 account_status, email_verified_at, pricing_tier_id, created_at`,
      [email, fname, lname, company, phone, password_hash]
    );

    // QBO customer creation is fire-and-forget — if it fails (e.g. QBO not
    // connected, network blip), the client row exists and we'll backfill
    // the qb_customer_id on the next sync. Don't fail registration on it.
    queueQboCustomerSync(inserted.id).catch((err) => {
      console.warn('QBO customer sync failed for client', inserted.id, err.message);
    });

    const token = signCustomerToken(inserted);
    await query(`UPDATE clients SET last_login_at = NOW() WHERE id = $1`, [inserted.id]);

    res.status(201).json({
      token,
      profile: publicProfile(inserted),
      message: 'Account created. Welcome to Holm Graphics!',
    });
  } catch (err) {
    console.error('register failed:', err);
    res.status(500).json({ message: 'Registration failed', detail: err.message });
  }
});

// Stub — real implementation added once QBO sync helper is extracted from
// routes/quickbooks.js. For now we just log so we know which clients need
// backfilling.
async function queueQboCustomerSync(clientId) {
  // TODO: extract pushSingleClient() from routes/quickbooks.js into
  // lib/qbo-sync.js so this can call it directly. For now this is a no-op
  // and `POST /api/quickbooks/clients/push` covers the gap.
  console.log(`[customer-auth] TODO: sync client ${clientId} to QBO`);
}

// ═════════════════════════════════════════════════════════════════════════════
// LOGIN
// ═════════════════════════════════════════════════════════════════════════════

// POST /api/customer/login   { email, password }
router.post('/login', async (req, res) => {
  try {
    const email    = normalizeEmail(req.body.email);
    const password = req.body.password || '';
    if (!email || !password) return res.status(400).json({ message: 'Email and password required' });

    const client = await findClientByEmail(email);
    if (!client) return res.status(401).json({ message: 'Invalid email or password' });

    if (client.account_status === 'suspended') {
      return res.status(403).json({ message: 'Account is suspended. Contact us at darren@holmgraphics.ca.' });
    }
    if (client.account_status === 'unactivated' || !client.password_hash) {
      // Auto-issue an activation link so the user knows what to do.
      const token = urlSafeToken();
      await query(
        `UPDATE clients SET activation_token = $1, activation_sent_at = NOW()
          WHERE id = $2`,
        [token, client.id]
      );
      await mailer.sendActivationEmail({ email: client.email, token, name: client.fname || '' });
      return res.status(403).json({
        message: 'Your account hasn\'t been activated yet. We\'ve emailed you an activation link.',
        code: 'activation_required',
      });
    }

    const valid = await bcrypt.compare(password, client.password_hash);
    if (!valid) return res.status(401).json({ message: 'Invalid email or password' });

    await query(`UPDATE clients SET last_login_at = NOW() WHERE id = $1`, [client.id]);
    const token = signCustomerToken(client);
    res.json({ token, profile: publicProfile(client) });
  } catch (err) {
    console.error('login failed:', err);
    res.status(500).json({ message: 'Login failed', detail: err.message });
  }
});

// ═════════════════════════════════════════════════════════════════════════════
// EXISTING-CUSTOMER ACTIVATION
// ═════════════════════════════════════════════════════════════════════════════

// POST /api/customer/request-activation   { email }
// Used by existing customers (or anyone who wants to claim a record).
// Always returns 200 to avoid revealing whether an email is on file.
router.post('/request-activation', async (req, res) => {
  try {
    const email = normalizeEmail(req.body.email);
    if (!isValidEmail(email)) return res.status(400).json({ message: 'Valid email required' });

    const client = await findClientByEmail(email);
    if (client && client.account_status !== 'suspended') {
      const token = urlSafeToken();
      await query(
        `UPDATE clients SET activation_token = $1, activation_sent_at = NOW()
          WHERE id = $2`,
        [token, client.id]
      );
      await mailer.sendActivationEmail({ email: client.email, token, name: client.fname || '' });
    }
    res.json({ message: 'If we have a record for that email, we\'ve sent an activation link.' });
  } catch (err) {
    console.error('request-activation failed:', err);
    res.status(500).json({ message: 'Could not send activation link', detail: err.message });
  }
});

// POST /api/customer/activate/:token   { password, fname?, lname?, phone? }
// Sets password and marks account active. Optional profile fields fill in
// gaps for QBO-imported customers who only have company and email.
router.post('/activate/:token', async (req, res) => {
  try {
    const { token } = req.params;
    const password = req.body.password || '';
    if (!isValidPassword(password)) return res.status(400).json({ message: 'Password must be 8–200 characters' });

    const client = await queryOne(
      `SELECT * FROM clients WHERE activation_token = $1 LIMIT 1`,
      [token]
    );
    if (!client) return res.status(404).json({ message: 'Activation link is invalid or already used' });

    // Activation links expire after ACTIVATION_TTL_HOURS hours.
    if (client.activation_sent_at) {
      const sentAt = new Date(client.activation_sent_at).getTime();
      const ageMs  = Date.now() - sentAt;
      if (ageMs > ACTIVATION_TTL_HOURS * 60 * 60 * 1000) {
        return res.status(410).json({ message: 'Activation link has expired. Request a new one.' });
      }
    }

    const password_hash = await bcrypt.hash(password, BCRYPT_ROUNDS);
    const fname = (req.body.fname || '').toString().trim() || client.fname;
    const lname = (req.body.lname || '').toString().trim() || client.lname;
    const phone = (req.body.phone || '').toString().trim() || client.phone;

    const updated = await queryOne(
      `UPDATE clients SET
         password_hash = $1,
         account_status = 'active',
         activation_token = NULL,
         activation_sent_at = NULL,
         fname = $2,
         lname = $3,
         phone = $4,
         email_verified_at = COALESCE(email_verified_at, NOW()),
         last_login_at = NOW()
       WHERE id = $5
       RETURNING id, email, fname, lname, company, phone, qb_customer_id,
                 account_status, email_verified_at, pricing_tier_id, created_at`,
      [password_hash, fname, lname, phone, client.id]
    );

    const jwtToken = signCustomerToken(updated);
    res.json({ token: jwtToken, profile: publicProfile(updated), message: 'Welcome! Your account is active.' });
  } catch (err) {
    console.error('activate failed:', err);
    res.status(500).json({ message: 'Activation failed', detail: err.message });
  }
});

// ═════════════════════════════════════════════════════════════════════════════
// PASSWORD RESET
// ═════════════════════════════════════════════════════════════════════════════

// POST /api/customer/forgot-password   { email }
// Always 200 — never confirm whether an email exists.
router.post('/forgot-password', async (req, res) => {
  try {
    const email = normalizeEmail(req.body.email);
    if (!isValidEmail(email)) return res.status(400).json({ message: 'Valid email required' });

    const client = await findClientByEmail(email);
    if (client && client.password_hash && client.account_status === 'active') {
      const token = urlSafeToken();
      const expires = new Date(Date.now() + PASSWORD_RESET_TTL_HOURS * 60 * 60 * 1000).toISOString();
      await query(
        `UPDATE clients SET password_reset_token = $1, password_reset_expires = $2
          WHERE id = $3`,
        [token, expires, client.id]
      );
      await mailer.sendPasswordResetEmail({ email: client.email, token, name: client.fname || '' });
    }
    res.json({ message: 'If we have a record for that email, we\'ve sent a password reset link.' });
  } catch (err) {
    console.error('forgot-password failed:', err);
    res.status(500).json({ message: 'Could not send reset link', detail: err.message });
  }
});

// POST /api/customer/reset-password   { token, password }
router.post('/reset-password', async (req, res) => {
  try {
    const { token } = req.body;
    const password = req.body.password || '';
    if (!token) return res.status(400).json({ message: 'Token required' });
    if (!isValidPassword(password)) return res.status(400).json({ message: 'Password must be 8–200 characters' });

    const client = await queryOne(
      `SELECT * FROM clients WHERE password_reset_token = $1 LIMIT 1`,
      [token]
    );
    if (!client) return res.status(404).json({ message: 'Reset link is invalid or already used' });
    if (!client.password_reset_expires ||
        new Date(client.password_reset_expires).getTime() < Date.now()) {
      return res.status(410).json({ message: 'Reset link has expired. Request a new one.' });
    }

    const password_hash = await bcrypt.hash(password, BCRYPT_ROUNDS);
    await query(
      `UPDATE clients SET
         password_hash = $1,
         password_reset_token = NULL,
         password_reset_expires = NULL,
         last_login_at = NOW()
       WHERE id = $2`,
      [password_hash, client.id]
    );

    const updated = await findClientById(client.id);
    const jwtToken = signCustomerToken(updated);
    res.json({ token: jwtToken, profile: publicProfile(updated), message: 'Password updated.' });
  } catch (err) {
    console.error('reset-password failed:', err);
    res.status(500).json({ message: 'Password reset failed', detail: err.message });
  }
});

// ═════════════════════════════════════════════════════════════════════════════
// "WHO AM I" + LOGOUT
// ═════════════════════════════════════════════════════════════════════════════

// GET /api/customer/me
router.get('/me', requireCustomer, async (req, res) => {
  try {
    const client = await findClientById(req.customer.id);
    if (!client) return res.status(404).json({ message: 'Account not found' });
    res.json({ profile: publicProfile(client) });
  } catch (err) {
    res.status(500).json({ message: 'Could not load profile', detail: err.message });
  }
});

// POST /api/customer/logout
// JWT is stateless, so logout is mostly a frontend concern (delete the
// token). We keep this endpoint for symmetry and to update last_login_at
// (helpful for "session ended at" reporting if we ever want it).
router.post('/logout', requireCustomer, async (req, res) => {
  try {
    await query(`UPDATE clients SET updated_at = NOW() WHERE id = $1`, [req.customer.id]);
    res.json({ message: 'Logged out' });
  } catch (err) {
    res.status(500).json({ message: 'Logout error', detail: err.message });
  }
});

// PUT /api/customer/me   { fname?, lname?, company?, phone? }
router.put('/me', requireCustomer, async (req, res) => {
  try {
    const fields = {};
    for (const k of ['fname', 'lname', 'company', 'phone']) {
      if (typeof req.body[k] === 'string') fields[k] = req.body[k].trim() || null;
    }
    if (!Object.keys(fields).length) return res.status(400).json({ message: 'No editable fields provided' });

    const setClauses = Object.keys(fields).map((k, i) => `${k} = $${i + 1}`).join(', ');
    const params = [...Object.values(fields), req.customer.id];
    const updated = await queryOne(
      `UPDATE clients SET ${setClauses} WHERE id = $${params.length}
       RETURNING id, email, fname, lname, company, phone, qb_customer_id,
                 account_status, email_verified_at, pricing_tier_id, created_at`,
      params
    );
    // TODO: push profile update to QBO via /customer endpoint (sparse update).
    res.json({ profile: publicProfile(updated) });
  } catch (err) {
    res.status(500).json({ message: 'Profile update failed', detail: err.message });
  }
});

module.exports = router;
