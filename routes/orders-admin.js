// routes/orders-admin.js
// Staff-only views and actions on online orders. Mounted at /api/admin/orders
// behind requireStaff so any logged-in employee can access (admin features
// like refund-arbitrary-amount can be gated more tightly later).
//
// Endpoints:
//   GET  /api/admin/orders                List (filterable by status/source)
//   GET  /api/admin/orders/:id            Full detail
//   POST /api/admin/orders/:id/ship       Generate ShipTime label, mark shipped
//   POST /api/admin/orders/:id/mark-ready-for-pickup
//   POST /api/admin/orders/:id/mark-picked-up
//   POST /api/admin/orders/:id/refund     { amount?, reason? } (full or partial)

'use strict';

const express = require('express');
const { query, queryOne } = require('../db/connection');
const { requireStaff, requireAdmin } = require('../middleware/auth');
const shiptime = require('../lib/shiptime');
const qbPayments = require('../lib/qb-payments');
const mailer = require('../lib/customer-mailer');

const router = express.Router();

router.use(requireStaff);

// ─── List / detail ───────────────────────────────────────────────────────────

router.get('/', async (req, res) => {
  try {
    const { status, source, limit = 50, offset = 0 } = req.query;
    const conds = [];
    const params = [];
    if (status) { params.push(status); conds.push(`o.status = $${params.length}`); }
    if (source) { params.push(source); conds.push(`o.source = $${params.length}`); }
    params.push(Number(limit) || 50);
    params.push(Number(offset) || 0);
    const where = conds.length ? `WHERE ${conds.join(' AND ')}` : '';

    const rows = await query(
      `SELECT o.id, o.order_number, o.status, o.source, o.fulfillment_method,
              o.grand_total, o.created_at, o.paid_at, o.shipped_at, o.picked_up_at,
              o.client_id, c.email AS customer_email,
              COALESCE(c.company, NULLIF(TRIM(COALESCE(c.fname,'') || ' ' || COALESCE(c.lname,'')), ''), c.email) AS customer_name
         FROM orders o
         JOIN clients c ON c.id = o.client_id
         ${where}
        ORDER BY o.created_at DESC
        LIMIT $${params.length - 1} OFFSET $${params.length}`,
      params
    );
    res.json({ orders: rows });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/:id', async (req, res) => {
  try {
    const order = await queryOne(
      `SELECT o.*,
              c.email AS customer_email, c.fname, c.lname, c.company, c.phone, c.qb_customer_id, c.files_folder
         FROM orders o
         JOIN clients c ON c.id = o.client_id
        WHERE o.id = $1`,
      [req.params.id]
    );
    if (!order) return res.status(404).json({ error: 'Order not found' });

    const [items, decorations, designs, proofs] = await Promise.all([
      query(`SELECT * FROM order_items WHERE order_id = $1 ORDER BY id`, [order.id]),
      query(`SELECT * FROM order_decorations WHERE order_id = $1 ORDER BY id`, [order.id]),
      query(`SELECT * FROM designs WHERE order_id = $1 ORDER BY uploaded_at`, [order.id]),
      query(`SELECT * FROM proofs WHERE order_id = $1 ORDER BY proof_number`, [order.id]),
    ]);

    res.json({ order, items, decorations, designs, proofs });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Ship: generate ShipTime label ───────────────────────────────────────────

router.post('/:id/ship', async (req, res) => {
  try {
    const order = await queryOne(
      `SELECT o.*, c.email AS customer_email, c.fname, c.lname, c.company, c.phone
         FROM orders o JOIN clients c ON c.id = o.client_id
        WHERE o.id = $1`,
      [req.params.id]
    );
    if (!order) return res.status(404).json({ error: 'Order not found' });
    if (order.fulfillment_method !== 'ship') {
      return res.status(409).json({ error: 'This is a pickup order — no shipping label needed.' });
    }
    if (!['in_production', 'ready_to_ship'].includes(order.status)) {
      return res.status(409).json({ error: `Cannot ship — status is "${order.status}".` });
    }
    if (order.shiptime_ship_id) {
      return res.status(409).json({ error: 'A shipment label has already been generated for this order.' });
    }

    // Re-quote ShipTime to get a fresh quoteId. Use the stored carrier/service
    // pair from checkout to pick the matching quote.
    const items = await query(
      `SELECT oi.quantity, sp.garment_category, sp.weight_grams
         FROM order_items oi
         LEFT JOIN supplier_product sp ON sp.supplier_id = oi.supplier AND sp.style = oi.style
        WHERE oi.order_id = $1`,
      [order.id]
    );
    const orderItems = items.map((i) => ({
      quantity:         i.quantity,
      weight_grams:     i.weight_grams || null,
      garment_category: i.garment_category || 'apparel',
    }));
    const shipTo = {
      name:     order.ship_to_name,
      addr1:    order.ship_to_addr1,
      addr2:    order.ship_to_addr2,
      city:     order.ship_to_city,
      province: order.ship_to_province,
      postal:   order.ship_to_postal,
      country:  order.ship_to_country,
      phone:    order.ship_to_phone,
      email:    order.customer_email,
    };
    const quote = await shiptime.quoteRates({ orderItems, shipTo });
    const chosen = quote.rates.find((r) => r.carrier_name === order.shipping_carrier && r.service_name === order.shipping_service);
    if (!chosen) {
      return res.status(409).json({
        error: 'The originally chosen carrier service is no longer available. Use the manual ShipTime workflow.',
        available_rates: quote.rates,
      });
    }

    const shipped = await shiptime.createShipment({
      rateRequest: quote.rate_request,
      carrierId:   chosen.carrier_id,
      serviceId:   chosen.service_id,
      ref1:        order.order_number,
    });

    await query(
      `UPDATE orders SET
         status = 'shipped',
         shiptime_ship_id = $1,
         tracking_number = $2,
         label_url = $3,
         shipped_at = NOW()
       WHERE id = $4`,
      [shipped.ship_id, (shipped.tracking_numbers || [])[0] || null, shipped.label_url, order.id]
    );

    mailer.sendOrderShipped({
      email: order.customer_email,
      order: {
        order_number:    order.order_number,
        tracking_number: (shipped.tracking_numbers || [])[0],
        shipping_carrier: order.shipping_carrier,
      },
    }).catch(() => {});

    res.json({
      ok: true,
      ship_id:           shipped.ship_id,
      tracking_numbers:  shipped.tracking_numbers,
      label_url:         shipped.label_url,
      carrier_tracking_url: shipped.carrier_tracking_url,
      status: 'shipped',
    });
  } catch (err) {
    console.error('ship failed:', err);
    res.status(500).json({ error: 'Shipping failed', detail: err.message });
  }
});

// ─── Pickup actions ──────────────────────────────────────────────────────────

router.post('/:id/mark-ready-for-pickup', async (req, res) => {
  try {
    const order = await queryOne(`SELECT o.*, c.email AS customer_email FROM orders o JOIN clients c ON c.id = o.client_id WHERE o.id = $1`, [req.params.id]);
    if (!order) return res.status(404).json({ error: 'Order not found' });
    if (order.fulfillment_method !== 'pickup') return res.status(409).json({ error: 'Not a pickup order' });
    if (!['in_production', 'ready_for_pickup'].includes(order.status)) {
      return res.status(409).json({ error: `Cannot mark ready — status is "${order.status}".` });
    }
    await query(
      `UPDATE orders SET status = 'ready_for_pickup', ready_at = NOW() WHERE id = $1`,
      [order.id]
    );
    mailer.sendOrderReadyForPickup({ email: order.customer_email, order }).catch(() => {});
    res.json({ ok: true, status: 'ready_for_pickup' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/:id/mark-picked-up', async (req, res) => {
  try {
    const order = await queryOne(`SELECT * FROM orders WHERE id = $1`, [req.params.id]);
    if (!order) return res.status(404).json({ error: 'Order not found' });
    if (order.fulfillment_method !== 'pickup') return res.status(409).json({ error: 'Not a pickup order' });
    await query(
      `UPDATE orders SET status = 'picked_up', picked_up_at = NOW() WHERE id = $1`,
      [order.id]
    );
    res.json({ ok: true, status: 'picked_up' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Refund ──────────────────────────────────────────────────────────────────

// POST /api/admin/orders/:id/refund   { amount?, reason? }
router.post('/:id/refund', requireAdmin, async (req, res) => {
  try {
    const order = await queryOne(`SELECT o.*, c.email AS customer_email FROM orders o JOIN clients c ON c.id = o.client_id WHERE o.id = $1`, [req.params.id]);
    if (!order) return res.status(404).json({ error: 'Order not found' });
    if (!order.qb_payment_id) return res.status(400).json({ error: 'No payment recorded for this order' });
    if (order.refunded_at) return res.status(409).json({ error: 'Already refunded' });

    const amount = req.body?.amount ? Number(req.body.amount) : Number(order.grand_total);
    const reason = (req.body?.reason || '').toString().slice(0, 500);

    const refund = await qbPayments.refund({
      chargeId:    order.qb_payment_id,
      amount,
      description: reason || `Refund for order ${order.order_number}`,
      requestId:   `refund-${order.id}-${Date.now()}`,
    });

    await query(
      `UPDATE orders SET
         status = CASE WHEN $1 >= grand_total THEN 'refunded' ELSE status END,
         qb_refund_id = $2,
         refunded_at = NOW(),
         notes = COALESCE(notes, '') || E'\nRefund: $' || $1::text || COALESCE(' — ' || $3::text, '')
       WHERE id = $4`,
      [amount, refund.refund_id, reason || null, order.id]
    );

    mailer.sendOrderRefunded({
      email:  order.customer_email,
      order:  { order_number: order.order_number },
      amount,
    }).catch(() => {});

    res.json({ ok: true, refund });
  } catch (err) {
    console.error('refund failed:', err);
    res.status(500).json({ error: 'Refund failed', detail: err.message });
  }
});

module.exports = router;
