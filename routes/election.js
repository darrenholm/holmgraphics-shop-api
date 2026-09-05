// routes/election.js
//
// The election order form, as a customer fills it in.
//
// A municipal candidate is a Holm Graphics customer like any other — several
// already are — so this does not invent a second account system, a second cart
// or a second order queue. It is the staff "new job" form with the guesswork
// taken out: predefined items at predefined prices, filled in by the client
// rather than by somebody at the counter, landing on the same jobs board.
//
// Mounted at /api/election.
//
//   GET  /api/election/catalogue        what is sold and what it costs  (public)
//   POST /api/election/quote            price a basket, save nothing    (public)
//   PUT  /api/election/drafts/:code     save a half-finished basket     (public)
//   GET  /api/election/drafts/:code     read one back                   (public)
//   GET  /api/election/drafts           the recent ones, for the phone  (staff)
//   POST /api/election/jobs             create the job as a Quote       (customer)
//   POST /api/election/jobs/:id/order   Quote -> Ordered                (customer)
//
// DRAFTS EXIST FOR THE TELEPHONE. Candidates ring partway through — "I'm on the
// sign bit and I don't know which thickness" — and without a saved draft the
// person answering is working blind. The caller reads out an eight-character
// code and staff open the same basket. The code is the access control; it holds
// sign quantities and a phone number, which is what that is worth.
//
// THE JOB IT CREATES. Type "Mixed", status "Quote", with one `items` row per
// line — the same rows staff add by hand, so the board, the totals and the
// QuickBooks path all work with no special case. Pressing Order moves it to
// "Ordered"; nothing else about the job changes.
//
// Statuses and types are resolved by name at request time rather than hardcoded
// as ids, because those tables are the shop's to edit and an id pinned here
// would rot silently.

'use strict';

const crypto = require('crypto');
const express = require('express');
const { query, queryOne } = require('../db/connection');
const { requireCustomer } = require('../middleware/customer-auth');
const { requireStaff } = require('../middleware/auth');
const { catalogue, priceOrder } = require('../lib/election-catalogue');

const router = express.Router();

const PROJECT_TYPE_NAME = 'Mixed';
const STATUS_QUOTE = 'Quote';
const STATUS_ORDERED = 'Ordered';

/** A lookup row's id by name, case-insensitively. Null when it is not there. */
async function idByName(table, name) {
  const row = await queryOne(
    `SELECT id FROM ${table} WHERE LOWER(name) = LOWER($1) LIMIT 1`,
    [name],
  );
  return row ? row.id : null;
}

// ─── GET /api/election/catalogue ─────────────────────────────────────────────
// Public: the storefront renders its form from this, so a candidate can see
// what a campaign costs before making an account.
router.get('/catalogue', (req, res) => {
  res.json(catalogue());
});

// ─── POST /api/election/quote ────────────────────────────────────────────────
// Public. Prices a basket and saves nothing, so the form can show a running
// total while it is being filled in.
router.post('/quote', (req, res) => {
  try {
    const { signs, print, decals, needs_artwork } = req.body || {};
    const priced = priceOrder({
      signs: signs || [],
      print: print || [],
      decals: decals || [],
      needsArtwork: Boolean(needs_artwork),
    });
    res.json({ ok: true, ...priced });
  } catch (e) {
    res.status(400).json({ ok: false, message: e.message });
  }
});

// ─── drafts ──────────────────────────────────────────────────────────────────

// No vowels, no 0/O or 1/I/L: it has to survive being read down a phone line
// and must not accidentally spell anything.
const CODE_ALPHABET = '23456789BCDFGHJKMNPQRSTVWXYZ';

function newCode() {
  const bytes = crypto.randomBytes(8);
  let out = '';
  for (const b of bytes) out += CODE_ALPHABET[b % CODE_ALPHABET.length];
  return out;
}

function cleanCode(raw) {
  const code = String(raw || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  return /^[A-Z0-9]{4,16}$/.test(code) ? code : null;
}

// PUT /api/election/drafts/:code — save as they type. Public: most of this form
// can be filled in before signing in, which is the whole point of showing
// prices to somebody who has not decided to run yet.
router.put('/drafts/:code', async (req, res) => {
  const code = cleanCode(req.params.code);
  if (!code) return res.status(400).json({ message: 'Bad code' });

  const {
    basket, candidate_name, office, municipality, ward,
    contact_name, contact_phone, contact_email, notes,
  } = req.body || {};

  try {
    await query(
      `INSERT INTO election_drafts (
          code, basket, candidate_name, office, municipality, ward,
          contact_name, contact_phone, contact_email, notes, updated_at
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, NOW())
       ON CONFLICT (code) DO UPDATE SET
          basket = EXCLUDED.basket,
          candidate_name = EXCLUDED.candidate_name,
          office = EXCLUDED.office,
          municipality = EXCLUDED.municipality,
          ward = EXCLUDED.ward,
          contact_name = EXCLUDED.contact_name,
          contact_phone = EXCLUDED.contact_phone,
          contact_email = EXCLUDED.contact_email,
          notes = EXCLUDED.notes,
          updated_at = NOW()`,
      [
        code, JSON.stringify(basket || {}),
        candidate_name || null, office || null, municipality || null, ward || null,
        contact_name || null, contact_phone || null, contact_email || null,
        notes ? String(notes).slice(0, 2000) : null,
      ],
    );
    res.json({ code });
  } catch (e) {
    console.error('PUT /election/drafts:', e);
    res.status(500).json({ message: 'Could not save the draft', detail: e.message });
  }
});

// GET /api/election/drafts/:code — what staff open when the phone rings, and
// what the candidate's own browser reloads from.
router.get('/drafts/:code', async (req, res) => {
  const code = cleanCode(req.params.code);
  if (!code) return res.status(400).json({ message: 'Bad code' });

  try {
    const draft = await queryOne(
      `SELECT code, basket, candidate_name, office, municipality, ward,
              contact_name, contact_phone, contact_email, notes,
              submitted_project_id, updated_at
         FROM election_drafts WHERE code = $1`,
      [code],
    );
    if (!draft) return res.status(404).json({ message: 'No draft with that code' });

    // Priced fresh from the price list, never from anything the draft stored:
    // a basket saved last week should quote at this week's prices.
    const basket = draft.basket || {};
    const priced = priceOrder({
      signs: basket.signs || [],
      print: basket.print || [],
      decals: basket.decals || [],
      needsArtwork: Boolean(basket.needs_artwork),
    });
    res.json({ ...draft, ...priced });
  } catch (e) {
    console.error('GET /election/drafts:', e);
    res.status(500).json({ message: 'Could not load the draft', detail: e.message });
  }
});

// GET /api/election/drafts — the ones on the go, newest first. For the person
// answering the phone to a caller who has lost their code but knows their name.
router.get('/drafts', requireStaff, async (req, res) => {
  const search = String(req.query.q || '').trim();
  try {
    const rows = await query(
      `SELECT code, candidate_name, office, municipality, contact_phone,
              submitted_project_id, updated_at
         FROM election_drafts
        WHERE submitted_project_id IS NULL
          AND ($1 = '' OR LOWER(candidate_name) LIKE LOWER('%' || $1 || '%')
                       OR contact_phone LIKE '%' || $1 || '%')
        ORDER BY updated_at DESC
        LIMIT 50`,
      [search],
    );
    res.json(rows);
  } catch (e) {
    console.error('GET /election/drafts list:', e);
    res.status(500).json({ message: 'Could not list drafts', detail: e.message });
  }
});

// ─── POST /api/election/jobs ─────────────────────────────────────────────────
// Create the job. Priced here from the basket, never from figures the browser
// sends: what a customer posts is what they want, not what it costs.
router.post('/jobs', requireCustomer, async (req, res) => {
  const {
    signs, print, decals, needs_artwork,
    candidate_name, office, municipality, ward,
    contact_name, contact_phone, contact_email,
    due_date, notes,
  } = req.body || {};

  const priced = priceOrder({
    signs: signs || [],
    print: print || [],
    decals: decals || [],
    needsArtwork: Boolean(needs_artwork),
  });

  if (priced.lines.length === 0) {
    return res.status(400).json({ message: 'Nothing on the order.' });
  }

  try {
    const [typeId, statusId] = await Promise.all([
      idByName('project_type', PROJECT_TYPE_NAME),
      idByName('status', STATUS_QUOTE),
    ]);
    if (!statusId) {
      return res.status(500).json({
        message: `No "${STATUS_QUOTE}" status exists, so the job would land in the wrong column.`,
      });
    }

    // What the board shows. A candidate's name and office is what somebody at
    // the shop needs to see at a glance; the lines carry the rest.
    const description = [
      'Election —',
      candidate_name || 'candidate',
      office ? `(${office}` : null,
      office && municipality ? `, ${municipality}` : (municipality ? `(${municipality}` : null),
      ward ? `, ${ward}` : null,
      office || municipality ? ')' : null,
    ].filter(Boolean).join(' ').replace(/\s+([,)])/g, '$1').slice(0, 500);

    const project = await queryOne(
      `INSERT INTO projects (
          description, client_id, project_type_id, status_id,
          due_date, contact_name, contact_phone, contact_email,
          created_date
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, CURRENT_DATE)
       RETURNING id`,
      [
        description,
        req.customer.id,
        typeId,
        statusId,
        due_date ? new Date(due_date) : null,
        contact_name || null,
        contact_phone || null,
        contact_email || null,
      ],
    );

    // One row per line, in the same table staff type into by hand. The item
    // type leads the description so the board sorts and reads by it.
    for (const line of priced.lines) {
      await query(
        `INSERT INTO items (project_id, description, qty, price, ext_price)
         VALUES ($1, $2, $3, $4, $5)`,
        [
          project.id,
          `[${line.item_type}] ${line.description}`.slice(0, 500),
          line.quantity,
          line.unit_price,
          line.total,
        ],
      );
    }

    if (notes && String(notes).trim()) {
      await query(
        `INSERT INTO notes (project_id, note, created_at)
         VALUES ($1, $2, NOW())`,
        [project.id, String(notes).trim().slice(0, 2000)],
      ).catch(() => {
        // A note is worth having and not worth failing an order over.
      });
    }

    // Keep the draft rather than deleting it, marked with the job it became:
    // a call that comes in just after can still be traced to what was ordered.
    const draftCode = cleanCode(req.body?.draft_code);
    if (draftCode) {
      await query(
        `UPDATE election_drafts
            SET submitted_project_id = $1, client_id = $2, updated_at = NOW()
          WHERE code = $3`,
        [project.id, req.customer.id, draftCode],
      ).catch(() => {
        // A draft that cannot be marked is not worth failing an order over.
      });
    }

    res.status(201).json({
      id: project.id,
      status: STATUS_QUOTE,
      subtotal: priced.subtotal,
      lines: priced.lines,
      message: 'Quote created.',
    });
  } catch (e) {
    console.error('POST /election/jobs:', e);
    res.status(500).json({ message: 'Could not create the job', detail: e.message });
  }
});

// ─── POST /api/election/jobs/:id/order ───────────────────────────────────────
// The candidate has seen the quote and wants it made. Owner-only: the job's
// client must be the customer asking.
router.post('/jobs/:id/order', requireCustomer, async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!Number.isInteger(id)) {
    return res.status(400).json({ message: 'Job id must be a number' });
  }

  try {
    const project = await queryOne(
      'SELECT id, client_id FROM projects WHERE id = $1',
      [id],
    );
    if (!project || project.client_id !== req.customer.id) {
      return res.status(404).json({ message: 'Job not found' });
    }

    const statusId = await idByName('status', STATUS_ORDERED);
    if (!statusId) {
      return res.status(500).json({ message: `No "${STATUS_ORDERED}" status exists.` });
    }

    await query('UPDATE projects SET status_id = $1 WHERE id = $2', [statusId, id]);
    res.json({ id, status: STATUS_ORDERED, message: 'Ordered.' });
  } catch (e) {
    console.error('POST /election/jobs/:id/order:', e);
    res.status(500).json({ message: 'Could not place the order', detail: e.message });
  }
});

module.exports = router;
