// routes/builder-orders.js
// Decoration builder draft endpoints, backing the /shop/builder UI in the
// holmgraphics-shop SvelteKit app. See spec: decoration-builder-spec.md.
//
// Endpoints (all mounted under /api/builder by server.js):
//
//   POST   /drafts                      → create a new draft, return id + session_token
//   GET    /drafts/:id                  → fetch draft state (requires session token)
//   PATCH  /drafts/:id                  → merge a JSON patch into state
//   POST   /drafts/:id/submit-for-proof → flip status to 'submitted', email admin
//
// Auth model: drafts are anonymous-friendly. POST returns a session_token
// that the client passes back via the `X-Builder-Session` header on
// subsequent calls. Mismatched tokens get a 403 — never 404 — so we don't
// leak draft existence.
//
// State shape (validated loosely; the schema lives on the frontend):
//   {
//     decoration_mode:  'uniform' | 'per_garment',
//     line_items: [{ id, label, family, color_hex, unit_price,
//                    sizes_offered, size_grid, locations, roster }],
//     totals: { garments, decoration, subtotal }
//   }
//
// Artwork: for v1, the client embeds blob: URLs in the state. A follow-up
// adds POST /drafts/:id/artwork (multipart) once a persistent storage
// backend is picked (files-bridge vs. S3 vs. Railway volume).

'use strict';

const express = require('express');
const crypto  = require('crypto');
const { query, queryOne } = require('../db/connection');
const { requireStaff } = require('../middleware/auth');
const mailer = require('../lib/customer-mailer');

const router = express.Router();

const ADMIN_NOTIFY_EMAIL =
  process.env.BUILDER_ADMIN_NOTIFY_EMAIL || 'darren@holmgraphics.ca';
const PUBLIC_SHOP_URL =
  process.env.PUBLIC_SHOP_URL || 'https://holmgraphics.ca';

// ─── helpers ─────────────────────────────────────────────────────────────────

function newSessionToken() {
  return crypto.randomBytes(24).toString('base64url');
}

function newApprovalToken() {
  // Slightly longer than session tokens — these get pasted into emails and
  // shared. Same charset, URL-safe.
  return crypto.randomBytes(32).toString('base64url');
}

function readSessionToken(req) {
  // Accept either header (preferred) or query param (debug-only).
  return (req.header('X-Builder-Session') || req.query.session || '').trim();
}

// Returns the draft row if token + id match, else null. Never throws on
// missing — callers map null to 403 (not 404) so we don't leak existence.
async function loadDraftWithAuth(id, token) {
  if (!id || !token) return null;
  return queryOne(
    `SELECT *
       FROM builder_drafts
      WHERE id = $1 AND session_token = $2`,
    [id, token]
  );
}

function isUuid(s) {
  return typeof s === 'string' &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s);
}

// ─── POST /drafts — create a new draft ──────────────────────────────────────

router.post('/drafts', async (req, res, next) => {
  try {
    const body  = req.body || {};
    const state = body.state && typeof body.state === 'object' ? body.state : {};
    const token = newSessionToken();

    const row = await queryOne(
      `INSERT INTO builder_drafts (session_token, state, contact_email, contact_name, contact_phone)
       VALUES ($1, $2::JSONB, $3, $4, $5)
       RETURNING id, session_token, status, state, created_at, updated_at`,
      [
        token,
        JSON.stringify(state),
        body.contact_email || null,
        body.contact_name  || null,
        body.contact_phone || null
      ]
    );

    res.status(201).json({
      id:            row.id,
      session_token: row.session_token,
      status:        row.status,
      state:         row.state,
      created_at:    row.created_at
    });
  } catch (err) { next(err); }
});

// ─── GET /drafts/:id — read draft state ─────────────────────────────────────

router.get('/drafts/:id', async (req, res, next) => {
  try {
    if (!isUuid(req.params.id)) return res.status(400).json({ error: 'invalid id' });
    const token = readSessionToken(req);
    const draft = await loadDraftWithAuth(req.params.id, token);
    if (!draft) return res.status(403).json({ error: 'forbidden' });

    res.json({
      id:            draft.id,
      status:        draft.status,
      state:         draft.state,
      contact_email: draft.contact_email,
      contact_name:  draft.contact_name,
      contact_phone: draft.contact_phone,
      submitted_at:  draft.submitted_at,
      created_at:    draft.created_at,
      updated_at:    draft.updated_at
    });
  } catch (err) { next(err); }
});

// ─── PATCH /drafts/:id — merge a state patch ────────────────────────────────
//
// Body:
//   { state?: object,           // replaces the JSONB state in full
//     contact_email?, contact_name?, contact_phone? }
//
// We REPLACE the state in full rather than do partial-merge — the client is
// the source of truth for the shape, and partial-merge across nested arrays
// (line_items[].locations[].roster[]) is error-prone. The frontend sends
// the whole state on save.

router.patch('/drafts/:id', async (req, res, next) => {
  try {
    if (!isUuid(req.params.id)) return res.status(400).json({ error: 'invalid id' });
    const token = readSessionToken(req);
    const draft = await loadDraftWithAuth(req.params.id, token);
    if (!draft) return res.status(403).json({ error: 'forbidden' });
    if (draft.status !== 'draft') {
      return res.status(409).json({ error: `cannot patch a ${draft.status} draft` });
    }

    const body = req.body || {};
    const sets = [];
    const args = [];
    let i = 1;

    if (body.state !== undefined) {
      if (typeof body.state !== 'object' || body.state === null) {
        return res.status(400).json({ error: 'state must be an object' });
      }
      sets.push(`state = $${i++}::JSONB`);
      args.push(JSON.stringify(body.state));
    }
    for (const field of ['contact_email', 'contact_name', 'contact_phone']) {
      if (body[field] !== undefined) {
        sets.push(`${field} = $${i++}`);
        args.push(body[field] || null);
      }
    }
    if (sets.length === 0) {
      return res.status(400).json({ error: 'no fields to update' });
    }

    args.push(req.params.id);
    const row = await queryOne(
      `UPDATE builder_drafts
          SET ${sets.join(', ')}
        WHERE id = $${i}
        RETURNING id, status, state, contact_email, contact_name, contact_phone, updated_at`,
      args
    );
    res.json(row);
  } catch (err) { next(err); }
});

// ─── POST /drafts/:id/submit-for-proof ──────────────────────────────────────
//
// Transitions a draft to 'submitted', emails the admin a summary, and
// returns the new state. After submission, the draft is read-only; further
// PATCH calls 409. For v1 the admin then manually creates a job/order from
// the submit email — automation lands in a later step.

router.post('/drafts/:id/submit-for-proof', async (req, res, next) => {
  try {
    if (!isUuid(req.params.id)) return res.status(400).json({ error: 'invalid id' });
    const token = readSessionToken(req);
    const draft = await loadDraftWithAuth(req.params.id, token);
    if (!draft) return res.status(403).json({ error: 'forbidden' });
    if (draft.status === 'submitted') {
      return res.status(409).json({ error: 'already submitted' });
    }
    if (draft.status === 'abandoned') {
      return res.status(409).json({ error: 'draft was abandoned' });
    }

    // Optional last-mile contact details on submit (override stored values).
    const body = req.body || {};
    const contactEmail = (body.contact_email || draft.contact_email || '').trim();
    const contactName  = (body.contact_name  || draft.contact_name  || '').trim();
    const contactPhone = (body.contact_phone || draft.contact_phone || '').trim();
    if (!contactEmail) {
      return res.status(400).json({ error: 'contact_email required to submit' });
    }

    // Fire the admin email BEFORE flipping status, so a mailer failure
    // doesn't strand a draft in 'submitted' with no notification. Mailer
    // never throws (returns ok:false on failure), so we check the return.
    const mail = await mailer.sendBuilderSubmittedForProof({
      to: ADMIN_NOTIFY_EMAIL,
      draftId: draft.id,
      state:   { ...draft.state, _contact: { email: contactEmail, name: contactName, phone: contactPhone } }
    });

    if (!mail.ok && !mail.stub) {
      // Mailer failed and we're not in stub mode — surface to caller so the
      // submit button can show a retry. Draft stays in 'draft' status.
      return res.status(502).json({ error: 'admin notification failed', detail: mail.error });
    }

    const row = await queryOne(
      `UPDATE builder_drafts
          SET status         = 'submitted',
              submitted_at   = NOW(),
              contact_email  = $1,
              contact_name   = $2,
              contact_phone  = $3,
              notify_email_id = $4
        WHERE id = $5
        RETURNING id, status, submitted_at`,
      [
        contactEmail,
        contactName  || null,
        contactPhone || null,
        mail.message_id || null,
        req.params.id
      ]
    );

    res.json({
      ...row,
      admin_notified: true,
      notify_email_stub: !!mail.stub
    });
  } catch (err) { next(err); }
});

// ─── POST /drafts/:id/send-proof  (staff) ────────────────────────────────────
//
// Admin attaches a proof image URL + payment link to a submitted draft,
// transitioning it from 'submitted' to 'proof_sent' and emailing the buyer
// a viewer URL.
//
// Body: { proof_image_url, payment_link_url, proof_message?, proof_sent_by? }
//
// proof_image_url is wherever the admin stored the mockup — for v1 the
// expectation is an L:\ jobs path served via files-bridge, but the column
// stores whatever URL the admin pastes (S3, Dropbox, etc.) so dev flexibility
// is preserved.

router.post('/drafts/:id/send-proof', requireStaff, async (req, res, next) => {
  try {
    if (!isUuid(req.params.id)) return res.status(400).json({ error: 'invalid id' });
    const draft = await queryOne(
      `SELECT id, status, contact_email, contact_name, approval_token, state
         FROM builder_drafts WHERE id = $1`,
      [req.params.id]
    );
    if (!draft) return res.status(404).json({ error: 'draft not found' });
    if (draft.status !== 'submitted' && draft.status !== 'proof_sent') {
      return res.status(409).json({
        error: `cannot send proof from ${draft.status} status`
      });
    }
    if (!draft.contact_email) {
      return res.status(409).json({ error: 'draft has no contact email' });
    }

    const body = req.body || {};
    const proofUrl   = (body.proof_image_url || '').trim();
    const paymentUrl = (body.payment_link_url || '').trim();
    const message    = (body.proof_message    || '').trim();
    const sentBy     = (body.proof_sent_by || req.staff?.email || '').trim();

    if (!proofUrl)   return res.status(400).json({ error: 'proof_image_url required' });
    if (!paymentUrl) return res.status(400).json({ error: 'payment_link_url required' });

    // Reuse existing approval_token if re-sending the proof; otherwise mint a
    // fresh one. Keeps a previously-shared link valid through revisions.
    const token = draft.approval_token || newApprovalToken();
    const viewerUrl = `${PUBLIC_SHOP_URL}/shop/builder/proof/${token}`;

    const mail = await mailer.sendBuilderProofReady({
      to:         draft.contact_email,
      name:       draft.contact_name,
      viewerUrl,
      paymentUrl,
      proofUrl,
      message,
      state:      draft.state
    });
    if (!mail.ok && !mail.stub) {
      return res.status(502).json({ error: 'buyer notification failed', detail: mail.error });
    }

    const row = await queryOne(
      `UPDATE builder_drafts
          SET status            = 'proof_sent',
              proof_image_url   = $1,
              payment_link_url  = $2,
              proof_message     = $3,
              approval_token    = $4,
              proof_sent_at     = NOW(),
              proof_sent_by     = $5
        WHERE id = $6
        RETURNING id, status, proof_sent_at, approval_token`,
      [proofUrl, paymentUrl, message || null, token, sentBy || null, req.params.id]
    );

    res.json({
      ...row,
      viewer_url:        viewerUrl,
      buyer_notified:    true,
      buyer_email_stub:  !!mail.stub
    });
  } catch (err) { next(err); }
});

// ─── GET /proof/:token  (public, token-authed) ──────────────────────────────
//
// Buyer-facing proof viewer feed. Returns the proof image URL, payment link,
// order summary, and approval state. The token in the URL is the auth — no
// session header needed (the link is shareable by design, mirroring how the
// existing /proofs.approval_token works).

router.get('/proof/:token', async (req, res, next) => {
  try {
    const token = (req.params.token || '').trim();
    if (!token) return res.status(400).json({ error: 'token required' });

    const draft = await queryOne(
      `SELECT id, status, proof_image_url, payment_link_url, proof_message,
              proof_sent_at, approved_at,
              contact_email, contact_name, state, submitted_at
         FROM builder_drafts
        WHERE approval_token = $1`,
      [token]
    );
    if (!draft) return res.status(404).json({ error: 'not found' });
    if (!['proof_sent', 'approved'].includes(draft.status)) {
      return res.status(409).json({ error: 'proof not available yet' });
    }

    // Strip internal-only fields from state before returning. The buyer
    // already submitted these but no need to expose them again here.
    const safeState = draft.state ? { ...draft.state } : {};
    delete safeState._contact;

    res.json({
      id:               draft.id,
      status:           draft.status,
      proof_image_url:  draft.proof_image_url,
      payment_link_url: draft.payment_link_url,
      proof_message:    draft.proof_message,
      proof_sent_at:    draft.proof_sent_at,
      approved_at:      draft.approved_at,
      contact: {
        email: draft.contact_email,
        name:  draft.contact_name
      },
      state:            safeState,
      submitted_at:     draft.submitted_at
    });
  } catch (err) { next(err); }
});

// ─── POST /proof/:token/approve  (public, token-authed) ─────────────────────
//
// Buyer clicks "Approve" on the viewer. Transitions proof_sent → approved
// and emails the admin. Idempotent: re-clicking on an already-approved draft
// returns the existing state without re-emailing.

router.post('/proof/:token/approve', async (req, res, next) => {
  try {
    const token = (req.params.token || '').trim();
    if (!token) return res.status(400).json({ error: 'token required' });

    const draft = await queryOne(
      `SELECT id, status, approved_at, contact_email, contact_name,
              proof_sent_by, payment_link_url, state
         FROM builder_drafts
        WHERE approval_token = $1`,
      [token]
    );
    if (!draft) return res.status(404).json({ error: 'not found' });
    if (draft.status === 'approved') {
      return res.json({ id: draft.id, status: 'approved', approved_at: draft.approved_at, already: true });
    }
    if (draft.status !== 'proof_sent') {
      return res.status(409).json({ error: `cannot approve from ${draft.status} status` });
    }

    // Notify admin of the approval. Failure here doesn't block the buyer's
    // action — the approval still records; admin gets a stale view but the
    // status column is authoritative.
    const mail = await mailer.sendBuilderApprovedNotice({
      to:          draft.proof_sent_by || ADMIN_NOTIFY_EMAIL,
      buyerEmail:  draft.contact_email,
      buyerName:   draft.contact_name,
      draftId:     draft.id,
      paymentUrl:  draft.payment_link_url,
      state:       draft.state
    });

    const row = await queryOne(
      `UPDATE builder_drafts
          SET status           = 'approved',
              approved_at      = NOW(),
              approve_email_id = $1
        WHERE id = $2
        RETURNING id, status, approved_at`,
      [mail.message_id || null, draft.id]
    );

    res.json({ ...row, admin_notified: mail.ok });
  } catch (err) { next(err); }
});

module.exports = router;
