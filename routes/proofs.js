// routes/proofs.js
// Proof workflow for the DTF online store.
//
// Staff side:
//   POST /api/proofs                       (multipart: order_id, file)
//     - Uploads a proof image/PDF for an order, copies it into
//       L:\...\Job<num>\proofs\proof-N.<ext>, increments proof_number,
//       generates an approval_token, emails the customer.
//
// Customer side (no auth — uses the signed token from the email):
//   GET  /api/proofs/by-token/:token       returns the proof + order summary
//   POST /api/proofs/by-token/:token/approve
//   POST /api/proofs/by-token/:token/request-changes  { message }
//   POST /api/proofs/by-token/:token/cancel           triggers refund
//
// Status transitions driven here:
//   awaiting_proof    →  awaiting_approval  (proof sent)
//   awaiting_approval →  in_production      (approved)
//   awaiting_approval →  awaiting_proof     (changes requested — staff redoes)
//   awaiting_approval →  cancelled / refunded (customer cancels)

'use strict';

const express = require('express');
const multer  = require('multer');
const crypto  = require('crypto');
const path    = require('path');
const { query, queryOne } = require('../db/connection');
const { requireStaff } = require('../middleware/auth');
const filesBridge = require('../lib/files-bridge-client');
const qbPayments  = require('../lib/qb-payments');
const mailer      = require('../lib/customer-mailer');

const router = express.Router();

const UPLOAD_MAX_BYTES = 50 * 1024 * 1024;
const upload = multer({
  storage: multer.memoryStorage(),
  limits:  { fileSize: UPLOAD_MAX_BYTES, files: 1 },
});

const PUBLIC_BASE = process.env.PUBLIC_SHOP_URL || 'https://shop.holmgraphics.ca';

// Reuse the same client-name resolver as designs.js. Inline copy keeps
// these route files self-contained.
function resolveClientNameForBridge(c) {
  if (c.files_folder) return c.files_folder;
  if (c.company)      return c.company;
  const parts = [c.fname, c.lname].filter(Boolean);
  if (parts.length) return parts.join(' ');
  return `Client${c.id}`;
}

// ═════════════════════════════════════════════════════════════════════════════
// STAFF: generate + send proof
// ═════════════════════════════════════════════════════════════════════════════

// POST /api/proofs   (multipart with `file` and form fields `order_id`)
router.post('/', requireStaff, upload.single('file'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'file field required' });
    const orderId = parseInt(req.body.order_id, 10);
    if (!Number.isInteger(orderId)) return res.status(400).json({ error: 'order_id required' });

    const order = await queryOne(
      `SELECT o.*, c.id AS client_id, c.email, c.fname, c.lname, c.company, c.files_folder
         FROM orders o
         JOIN clients c ON c.id = o.client_id
        WHERE o.id = $1`,
      [orderId]
    );
    if (!order) return res.status(404).json({ error: 'Order not found' });
    if (!['awaiting_proof', 'awaiting_approval'].includes(order.status)) {
      return res.status(409).json({
        error: `Cannot generate proof — order status is "${order.status}".`,
      });
    }

    // Determine the next proof number for this order.
    const last = await queryOne(
      `SELECT COALESCE(MAX(proof_number), 0) AS n FROM proofs WHERE order_id = $1`,
      [orderId]
    );
    const proofNumber = (last.n || 0) + 1;

    // Upload to files-bridge under the job folder.
    const ext = path.extname(req.file.originalname || '').toLowerCase() || '.pdf';
    const filename = `proof-${proofNumber}${ext}`;
    const clientName = resolveClientNameForBridge(order);
    const saved = await filesBridge.uploadFile({
      clientName,
      jobNo:     order.job_id,
      subfolder: 'proofs',
      fileName:  filename,
      fileBuffer: req.file.buffer,
      mimeType:  req.file.mimetype || 'application/octet-stream',
    });

    // Insert the proof row.
    const approvalToken = crypto.randomBytes(32).toString('base64url');
    const proofRow = await queryOne(
      `INSERT INTO proofs (order_id, proof_number, proof_image_path,
                           approval_token, created_by, sent_at)
            VALUES ($1, $2, $3, $4, $5, NOW())
         RETURNING *`,
      [orderId, proofNumber, saved.path, approvalToken, req.user.email || 'staff']
    );

    // Move order to awaiting_approval.
    await query(
      `UPDATE orders SET status = 'awaiting_approval', proof_sent_at = NOW() WHERE id = $1`,
      [orderId]
    );

    const approvalUrl = `${PUBLIC_BASE}/order/${order.order_number}/proof/${approvalToken}`;
    mailer.sendProofRequest({
      email: order.email,
      order,
      proof: proofRow,
      approvalUrl,
    }).catch((e) => console.warn('proof email send failed:', e.message));

    res.status(201).json({
      ok: true,
      proof: {
        id:           proofRow.id,
        proof_number: proofRow.proof_number,
        approval_token: approvalToken,
        approval_url:  approvalUrl,
        path:         saved.path,
      },
      order_status: 'awaiting_approval',
    });
  } catch (err) {
    console.error('proof generate failed:', err);
    res.status(500).json({ error: 'Failed to generate proof', detail: err.message });
  }
});

// ═════════════════════════════════════════════════════════════════════════════
// CUSTOMER: token-protected proof actions
// ═════════════════════════════════════════════════════════════════════════════

async function loadProofByToken(token) {
  const row = await queryOne(
    `SELECT p.*, o.order_number, o.client_id, o.status AS order_status,
            o.fulfillment_method, o.qb_payment_id, o.grand_total,
            c.email, c.fname, c.lname, c.company
       FROM proofs p
       JOIN orders o ON o.id = p.order_id
       JOIN clients c ON c.id = o.client_id
      WHERE p.approval_token = $1
      LIMIT 1`,
    [token]
  );
  return row;
}

// GET /api/proofs/by-token/:token
router.get('/by-token/:token', async (req, res) => {
  try {
    const proof = await loadProofByToken(req.params.token);
    if (!proof) return res.status(404).json({ error: 'Proof not found or link expired' });
    res.json({
      proof: {
        id:                  proof.id,
        order_number:        proof.order_number,
        proof_number:        proof.proof_number,
        sent_at:             proof.sent_at,
        approved_at:         proof.approved_at,
        changes_requested_at: proof.changes_requested_at,
        cancelled_at:        proof.cancelled_at,
        order_status:        proof.order_status,
        fulfillment_method:  proof.fulfillment_method,
        // proof image is fetched separately via the files-bridge URL
      },
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/proofs/by-token/:token/approve
router.post('/by-token/:token/approve', async (req, res) => {
  try {
    const proof = await loadProofByToken(req.params.token);
    if (!proof) return res.status(404).json({ error: 'Proof not found' });
    if (proof.cancelled_at)        return res.status(409).json({ error: 'Proof was cancelled.' });
    if (proof.approved_at)         return res.json({ ok: true, already_approved: true });
    if (proof.order_status !== 'awaiting_approval') {
      return res.status(409).json({ error: `Order is in "${proof.order_status}" — can't approve now.` });
    }

    await query(`UPDATE proofs SET approved_at = NOW() WHERE id = $1`, [proof.id]);
    await query(`UPDATE orders SET status = 'in_production', approved_at = NOW() WHERE id = $1`, [proof.order_id]);

    mailer.sendOrderApproved({
      email: proof.email,
      order: { order_number: proof.order_number },
    }).catch(() => {});

    res.json({ ok: true, status: 'in_production' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/proofs/by-token/:token/request-changes  { message }
router.post('/by-token/:token/request-changes', async (req, res) => {
  try {
    const message = (req.body?.message || '').toString().slice(0, 4000);
    const proof = await loadProofByToken(req.params.token);
    if (!proof) return res.status(404).json({ error: 'Proof not found' });
    if (proof.cancelled_at) return res.status(409).json({ error: 'Proof was cancelled.' });
    if (proof.order_status !== 'awaiting_approval') {
      return res.status(409).json({ error: `Order is in "${proof.order_status}" — can't request changes now.` });
    }

    await query(
      `UPDATE proofs SET changes_requested_at = NOW(), changes_request_text = $1
        WHERE id = $2`,
      [message || null, proof.id]
    );
    // Move order back to awaiting_proof so staff can generate a new proof.
    await query(
      `UPDATE orders SET status = 'awaiting_proof', proof_sent_at = NULL WHERE id = $1`,
      [proof.order_id]
    );

    res.json({ ok: true, status: 'awaiting_proof', message: 'Thanks — we\'ll send a revised proof shortly.' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/proofs/by-token/:token/cancel  — cancel + refund
router.post('/by-token/:token/cancel', async (req, res) => {
  try {
    const proof = await loadProofByToken(req.params.token);
    if (!proof) return res.status(404).json({ error: 'Proof not found' });
    if (!['awaiting_proof', 'awaiting_approval', 'awaiting_artwork'].includes(proof.order_status)) {
      return res.status(409).json({
        error: `Order is in "${proof.order_status}" — can no longer cancel via the proof link. Contact us at darren@holmgraphics.ca.`,
      });
    }

    // Mark the proof cancelled.
    await query(
      `UPDATE proofs SET cancelled_at = NOW() WHERE id = $1`,
      [proof.id]
    );

    // Issue refund via QB Payments (if we have a payment id).
    let refundResult = null;
    if (proof.qb_payment_id) {
      try {
        refundResult = await qbPayments.refund({
          chargeId:    proof.qb_payment_id,
          description: `Order ${proof.order_number} cancelled at proof stage`,
          requestId:   `cancel-${proof.order_id}`,
        });
        await query(
          `UPDATE orders SET
              status = 'refunded',
              cancelled_at = NOW(),
              refunded_at  = NOW(),
              qb_refund_id = $1
            WHERE id = $2`,
          [refundResult.refund_id, proof.order_id]
        );
      } catch (refundErr) {
        console.error('refund failed:', refundErr);
        // Mark order cancelled but flag refund as needing manual attention.
        await query(
          `UPDATE orders SET status = 'cancelled', cancelled_at = NOW(),
                  notes = COALESCE(notes, '') || E'\nREFUND FAILED: ' || $1
            WHERE id = $2`,
          [refundErr.message, proof.order_id]
        );
        return res.status(202).json({
          ok: true,
          status: 'cancelled',
          warning: 'Order cancelled, but automatic refund failed. We\'ll process the refund manually within 1 business day.',
          refund_error: refundErr.message,
        });
      }
    } else {
      await query(
        `UPDATE orders SET status = 'cancelled', cancelled_at = NOW() WHERE id = $1`,
        [proof.order_id]
      );
    }

    mailer.sendOrderRefunded({
      email: proof.email,
      order: { order_number: proof.order_number },
      amount: Number(proof.grand_total),
    }).catch(() => {});

    res.json({
      ok:     true,
      status: 'refunded',
      refund: refundResult,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
