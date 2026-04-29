// routes/orders.js
// Customer-facing order endpoints for the DTF online store.
//
// Flow:
//   1. Customer browses catalog, builds a cart in localStorage.
//   2. As the cart changes, the frontend calls POST /api/orders/quote to get
//      a live price breakdown (no commitment, no charge).
//   3. At checkout, the frontend calls POST /api/orders/shipping-rates with
//      the cart + ship-to address; we return a list of carrier options.
//   4. Customer picks a rate, enters/selects a card (tokenized by Intuit's
//      JS SDK on the browser), and POSTs to /api/orders.
//   5. POST /api/orders does the heavy lifting:
//        a. Recompute prices server-side (don't trust client).
//        b. Re-quote ShipTime to get a fresh quoteId (15-min expiry).
//        c. Create or upsert the QBO Customer.
//        d. Create the project (job) row in DB.
//        e. Charge the card via QB Payments.
//        f. Create the QBO Sales Receipt.
//        g. Persist the order, items, designs, decorations.
//        h. Return the order. Customer is then redirected to upload artwork.
//   6. After artwork upload, status flips to 'awaiting_proof' and the
//      staff job board sees a new job.
//
// All endpoints under /api/orders require a customer JWT, except the public
// /quote and /shipping-rates which can compute prices for guests too (so
// the cart UI works before they log in).

'use strict';

const express = require('express');
const db = require('../db/connection');
const { query, queryOne, pool } = db;
const { requireCustomer } = require('../middleware/customer-auth');
const { priceCart } = require('../lib/dtf-pricing');
const { getConfig: getDtfConfig } = require('../lib/dtf-pricing-loader');
const shiptime = require('../lib/shiptime');
const qbPayments = require('../lib/qb-payments');
const mailer = require('../lib/customer-mailer');
const { maybePromoteJob } = require('../lib/promote-job');

const router = express.Router();

// ─── helpers ─────────────────────────────────────────────────────────────────

// Validate cart shape and minimum required fields. Throws on missing data.
function validateCart(cart) {
  if (!cart || typeof cart !== 'object') throw new Error('cart required');
  if (!Array.isArray(cart.items) || cart.items.length === 0) {
    throw new Error('cart must contain at least one item');
  }
  for (const [i, item] of cart.items.entries()) {
    if (!item.supplier)    throw new Error(`item[${i}]: supplier required`);
    if (!item.style)       throw new Error(`item[${i}]: style required`);
    if (!item.variant_id)  throw new Error(`item[${i}]: variant_id required`);
    if (!item.size)        throw new Error(`item[${i}]: size required`);
    if (!Number.isInteger(item.quantity) || item.quantity < 1) {
      throw new Error(`item[${i}]: quantity must be a positive integer`);
    }
    if (typeof item.unit_price !== 'number' || !Number.isFinite(item.unit_price) || item.unit_price < 0) {
      throw new Error(`item[${i}]: unit_price must be a non-negative number`);
    }
    for (const [j, dec] of (item.decorations || []).entries()) {
      if (!dec.design_id) throw new Error(`item[${i}].decorations[${j}]: design_id required`);
      if (dec.print_location_id == null && (!dec.width_in || !dec.height_in)) {
        throw new Error(`item[${i}].decorations[${j}]: custom decorations require width_in and height_in`);
      }
    }
  }
}

// Validate a ship-to address (only when fulfillment_method === 'ship').
function validateShipTo(s) {
  if (!s || typeof s !== 'object') throw new Error('ship_to required for shipped orders');
  for (const f of ['name', 'addr1', 'city', 'province', 'postal']) {
    if (!s[f]) throw new Error(`ship_to.${f} required`);
  }
  if (!/^[A-Z]{2}$/i.test(s.province)) throw new Error('ship_to.province must be a 2-letter code');
  if (!s.country) s.country = 'CA';
}

// ═════════════════════════════════════════════════════════════════════════════
// GET /api/orders/quote   (POST — body has cart)
// Compute pricing for a cart. No order created, no charge. Public so the
// cart UI works before login.
// ═════════════════════════════════════════════════════════════════════════════
router.post('/quote', async (req, res) => {
  try {
    const { cart, ship_to, fulfillment_method = 'ship', shipping_total = 0 } = req.body;
    validateCart(cart);

    const config = await getDtfConfig();
    const shipTo = ship_to || {};
    const shippingTotal = fulfillment_method === 'pickup' ? 0 : Number(shipping_total) || 0;

    const breakdown = priceCart({ cart, config, shipTo, shippingTotal });
    res.json({ ok: true, fulfillment_method, breakdown });
  } catch (err) {
    res.status(400).json({ ok: false, error: err.message });
  }
});

// ═════════════════════════════════════════════════════════════════════════════
// POST /api/orders/shipping-rates
// Quote ShipTime carriers for a cart + ship-to. Public (cart UI uses
// during the address step before checkout).
// ═════════════════════════════════════════════════════════════════════════════
router.post('/shipping-rates', async (req, res) => {
  try {
    const { cart, ship_to } = req.body;
    validateCart(cart);
    validateShipTo(ship_to);

    // Build orderItems shape ShipTime helper wants. Each cart item gives us
    // quantity + we look up weight + category from supplier_product. If
    // unknown, helper applies defaults by category.
    const variants = cart.items.map((it) => ({ supplier: it.supplier, style: it.style }));
    const productMeta = await loadProductMeta(variants);
    const orderItems = cart.items.map((it) => {
      const meta = productMeta.find((m) =>
        m.supplier === it.supplier && m.style === it.style) || {};
      return {
        quantity:         it.quantity,
        weight_grams:     meta.weight_grams || null,
        garment_category: meta.garment_category || 'apparel',
      };
    });

    const { rates } = await shiptime.quoteRates({ orderItems, shipTo: ship_to });
    res.json({ ok: true, rates });
  } catch (err) {
    console.error('shipping-rates failed:', err);
    // NEVER propagate an upstream 401 verbatim. The frontend's customer
    // auth client treats any 401 as "customer JWT expired" and bounces
    // to /shop/login -- which is wrong when it was actually ShipTime
    // rejecting OUR API credentials. Map upstream auth failures to 502.
    const statusOut = err.status === 401 || err.status === 403
      ? 502
      : (err.status || 500);
    res.status(statusOut).json({
      ok:     false,
      error:  statusOut === 502
                ? 'Shipping provider is unavailable. Please try again, or call us.'
                : err.message,
      // Always include err.message in detail so an upstream 401 with an
      // empty body still surfaces the diagnostic (e.g. "ShipTime 401: ...")
      // without having to dig in Railway logs.
      detail: err.body || err.message || null,
    });
  }
});

async function loadProductMeta(variants) {
  if (!variants.length) return [];
  // The cart stores supplier as a TEXT code (e.g. "sanmar_ca") in
  // it.supplier, but supplier_product.supplier_id is an INTEGER FK to
  // supplier.id. Join through the supplier table to translate, and
  // return the code (not the id) so the call site's `m.supplier ===
  // it.supplier` comparison works.
  // NB: column on supplier_product is `style`, not `style_number`.
  const conds = variants.map(
    (_, i) => `(s.code = $${i*2+1} AND sp.style = $${i*2+2})`
  );
  const params = variants.flatMap((v) => [v.supplier, v.style]);
  return query(
    `SELECT s.code AS supplier, sp.style,
            sp.garment_category, sp.weight_grams
       FROM supplier_product sp
       JOIN supplier s ON s.id = sp.supplier_id
      WHERE ${conds.join(' OR ')}`,
    params
  );
}

// ═════════════════════════════════════════════════════════════════════════════
// POST /api/orders
// Create an order. Requires customer JWT. Charges the card immediately
// (option 7c per plan: full charge at checkout, refund on cancel).
//
// Request body:
//   {
//     cart: { items: [...], designs: [{id,name},...] },
//     fulfillment_method: 'ship' | 'pickup',
//     ship_to: { name, addr1, addr2?, city, province, postal, country?, phone, email? },
//     shipping_quote_id: <ShipTime quote id chosen by customer>  (ship only),
//     shipping_carrier_id: <string>,                              (ship only)
//     shipping_service_id: <string>,                              (ship only)
//     payment: { card_token: '...' } | { saved_card_id: 123 },
//     customer_notes: string?
//   }
// ═════════════════════════════════════════════════════════════════════════════
router.post('/', requireCustomer, async (req, res) => {
  const startedAt = Date.now();
  let createdJobId = null;
  let chargedId = null;

  try {
    const {
      cart,
      fulfillment_method = 'ship',
      ship_to,
      shipping_quote_id,
      shipping_carrier_id,
      shipping_service_id,
      payment,
      customer_notes,
    } = req.body;

    if (!['ship', 'pickup'].includes(fulfillment_method)) {
      return res.status(400).json({ error: 'fulfillment_method must be "ship" or "pickup"' });
    }
    validateCart(cart);
    if (fulfillment_method === 'ship') validateShipTo(ship_to);
    if (!payment || (!payment.card_token && !payment.saved_card_id)) {
      return res.status(400).json({ error: 'payment.card_token or saved_card_id required' });
    }

    // ─── Load customer ──────────────────────────────────────────────────────
    const customer = await queryOne(
      `SELECT id, email, fname, lname, company, phone, qb_customer_id
         FROM clients WHERE id = $1`,
      [req.customer.id]
    );
    if (!customer) return res.status(404).json({ error: 'Customer not found' });

    // ─── Recompute pricing server-side (authoritative) ──────────────────────
    const config = await getDtfConfig();
    let shippingTotal = 0;
    let chosenRate = null;
    let freshQuoteId = null;
    let rateRequest = null;

    if (fulfillment_method === 'ship') {
      // Re-quote ShipTime to dodge the 15-min quoteId expiry. Pick the
      // matching service from the fresh response.
      const variants = cart.items.map((it) => ({ supplier: it.supplier, style: it.style }));
      const productMeta = await loadProductMeta(variants);
      const orderItems = cart.items.map((it) => {
        const meta = productMeta.find((m) =>
          m.supplier === it.supplier && m.style === it.style) || {};
        return {
          quantity:         it.quantity,
          weight_grams:     meta.weight_grams || null,
          garment_category: meta.garment_category || 'apparel',
        };
      });
      const quote = await shiptime.quoteRates({ orderItems, shipTo: ship_to });
      rateRequest = quote.rate_request;
      chosenRate = quote.rates.find((r) =>
        r.carrier_id === shipping_carrier_id && r.service_id === shipping_service_id
      );
      if (!chosenRate) {
        return res.status(409).json({
          error: 'The chosen shipping option is no longer available. Please pick a different one.',
          available_rates: quote.rates,
        });
      }
      freshQuoteId  = chosenRate.quote_id;
      shippingTotal = chosenRate.total_charge;
    }

    const breakdown = priceCart({
      cart,
      config,
      shipTo: ship_to || {},
      shippingTotal,
    });

    // ─── Charge the card ────────────────────────────────────────────────────
    const orderRefForCharge = `HG-${Date.now()}`;
    let card;
    if (payment.card_token) {
      card = { token: payment.card_token };
    } else {
      const saved = await queryOne(
        `SELECT qb_card_token, card_brand, card_last4
           FROM client_payment_methods
          WHERE id = $1 AND client_id = $2`,
        [payment.saved_card_id, customer.id]
      );
      if (!saved) return res.status(404).json({ error: 'Saved card not found' });
      card = { token: saved.qb_card_token, brand: saved.card_brand, last4: saved.card_last4 };
    }

    const chargeResult = await qbPayments.charge({
      token:       card.token,
      amount:      breakdown.grand_total,
      currency:    'CAD',
      description: `Holm Graphics order — ${customer.email}`,
      requestId:   orderRefForCharge,
    });

    if (!chargeResult.ok) {
      return res.status(402).json({
        error: `Card declined (${chargeResult.status}). Please try a different card.`,
        decline_status: chargeResult.status,
      });
    }
    chargedId = chargeResult.charge_id;

    // From here on, any thrown error must trigger a compensating refund.
    // The inner try wraps everything that can fail post-charge so the catch
    // can await the refund and report its outcome to the customer.
    try {
    // ─── Persist everything in a single transaction ─────────────────────────
    const client = await pool.connect();
    let order;
    try {
      await client.query('BEGIN');

      // Create the project (job) row. Match the existing schema as best we
      // can — projects table is shared with the staff job board.
      // We use a minimal set of columns; the rest will be NULL until staff
      // edit the job.
      const project = await client.query(
        `INSERT INTO projects (client_id, status_id, created_at)
              VALUES ($1, 1, NOW())
           RETURNING id`,
        [customer.id]
      );
      createdJobId = project.rows[0].id;
      const orderNumber = String(createdJobId);

      // Resolve the notification email captured at checkout. ship_to.email
      // (set on both ship and pickup forms) overrides the account email
      // for this one order — see lib/customer-mailer.js sendForOrderStatus.
      // Falls back to clients.email at send time if NULL/empty here.
      const notificationEmail = (ship_to && typeof ship_to.email === 'string' && ship_to.email.trim())
        ? ship_to.email.trim()
        : null;

      // Build the QBO description from the breakdown so the Sales Receipt
      // shows itemized pricing in the customer's portal.
      const orderRow = await client.query(
        `INSERT INTO orders (
            order_number, job_id, client_id, source, status,
            items_subtotal, shipping_total, tax_total, grand_total,
            fulfillment_method,
            ship_to_name, ship_to_addr1, ship_to_addr2, ship_to_city,
            ship_to_province, ship_to_postal, ship_to_country, ship_to_phone,
            shipping_carrier, shipping_service, shipping_quote_id,
            qb_payment_id,
            customer_notes,
            notification_email,
            paid_at
          ) VALUES (
            $1, $2, $3, 'online', 'awaiting_artwork',
            $4, $5, $6, $7,
            $8,
            $9, $10, $11, $12, $13, $14, $15, $16,
            $17, $18, $19,
            $20,
            $21,
            $22,
            NOW()
          )
          RETURNING id, order_number, status, grand_total`,
        [
          orderNumber, createdJobId, customer.id,
          breakdown.items_subtotal, breakdown.shipping_total, breakdown.tax_total, breakdown.grand_total,
          fulfillment_method,
          fulfillment_method === 'ship' ? ship_to.name : null,
          fulfillment_method === 'ship' ? ship_to.addr1 : null,
          fulfillment_method === 'ship' ? (ship_to.addr2 || null) : null,
          fulfillment_method === 'ship' ? ship_to.city : null,
          fulfillment_method === 'ship' ? ship_to.province.toUpperCase() : null,
          fulfillment_method === 'ship' ? ship_to.postal : null,
          fulfillment_method === 'ship' ? (ship_to.country || 'CA') : null,
          fulfillment_method === 'ship' ? (ship_to.phone || null) : null,
          chosenRate?.carrier_name || null,
          chosenRate?.service_name || null,
          freshQuoteId,
          chargedId,
          customer_notes || null,
          notificationEmail,
        ]
      );
      order = orderRow.rows[0];

      // Persist designs (placeholders — actual file path assigned at upload time).
      const designIdMap = new Map();   // client-side temp id → DB uuid
      for (const d of (cart.designs || [])) {
        const insert = await client.query(
          `INSERT INTO designs (order_id, name, artwork_path, artwork_filename)
                VALUES ($1, $2, $3, $4)
             RETURNING id`,
          [order.id, d.name || 'Untitled design', '(pending upload)', d.filename || 'pending']
        );
        designIdMap.set(d.id, insert.rows[0].id);
      }
      // Auto-create a design row for any decoration referencing a design_id
      // that wasn't in cart.designs (defensive — frontend may send sparse).
      for (const item of cart.items) {
        for (const dec of (item.decorations || [])) {
          if (dec.design_id && !designIdMap.has(dec.design_id)) {
            const insert = await client.query(
              `INSERT INTO designs (order_id, name, artwork_path, artwork_filename)
                    VALUES ($1, $2, $3, $4)
                 RETURNING id`,
              [order.id, `Design ${designIdMap.size + 1}`, '(pending upload)', 'pending']
            );
            designIdMap.set(dec.design_id, insert.rows[0].id);
          }
        }
      }

      // Persist line items + decorations.
      for (const item of cart.items) {
        const insertItem = await client.query(
          `INSERT INTO order_items (
              order_id, supplier, style, variant_id, product_name,
              color_name, color_hex, size, quantity, unit_price, line_subtotal
           ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
           RETURNING id`,
          [
            order.id,
            item.supplier, item.style, item.variant_id, item.product_name || `${item.style}`,
            item.color_name || '', item.color_hex || null,
            item.size, item.quantity,
            item.unit_price,
            Number((item.quantity * item.unit_price).toFixed(2)),
          ]
        );
        const orderItemId = insertItem.rows[0].id;

        // Find this line's breakdown to pull decoration costs.
        const lineBreak = breakdown.line_breakdown.find((lb) => lb.item_id === item.id) ||
                          { decorations: [] };

        for (const dec of (item.decorations || [])) {
          const designDbId = designIdMap.get(dec.design_id);
          const decBreak   = lineBreak.decorations.find((d) => d.decoration_id === dec.id) ||
                             { line_cost: 0, setup_fee: 0 };
          await client.query(
            `INSERT INTO order_decorations (
                order_id, order_item_id, design_id,
                print_location_id, custom_location, width_in, height_in,
                decoration_cost, setup_fee
             ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
            [
              order.id, orderItemId, designDbId,
              dec.print_location_id || null,
              dec.custom_location || null,
              dec.width_in || null,
              dec.height_in || null,
              decBreak.line_cost,
              decBreak.setup_fee,
            ]
          );
        }
      }

      // Auto-promote the linked project: assign to production + advance to
      // "Ordered". Both promotion preconditions (paid_at set, ≥1 design row)
      // are guaranteed at this point — we just inserted both above. The
      // helper re-checks idempotently and joins this transaction so a
      // failed promotion rolls back the entire order.
      await maybePromoteJob(client, order.id);

      await client.query('COMMIT');
    } catch (txErr) {
      await client.query('ROLLBACK');
      throw txErr;
    } finally {
      client.release();
    }

    // ─── Best-effort post-commit work (don't fail the order) ────────────────
    // QBO Sales Receipt creation: fire-and-forget. If it fails, an admin
    // can re-sync from the order detail page later. The card has already
    // been charged so the customer's experience is unaffected.
    queueQboSalesReceipt(order.id).catch((e) =>
      console.warn(`QBO sales receipt for order ${order.id} failed:`, e.message)
    );

    // Order confirmation email — routed through the status-driven dispatcher
    // so it logs to email_log (idempotent: maybePromoteJob inside the tx
    // already advanced status_id to ORDERED=2). Fire-and-forget — never
    // throws, never blocks the order response.
    mailer.sendForOrderStatus({ orderId: order.id, statusId: 2, db }).catch(() => {});

    res.status(201).json({
      ok: true,
      order: {
        id:                order.id,
        order_number:      order.order_number,
        status:            order.status,
        grand_total:       Number(order.grand_total),
        next_step:         'upload_artwork',
        next_step_url:     `/order/${order.order_number}/upload`,
      },
      breakdown,
      took_ms: Date.now() - startedAt,
    });
    } catch (postChargeErr) {
      // The card has been charged but persistence failed. Await the refund
      // synchronously so we know whether the customer is whole, and report
      // the outcome — never leave them charged silently.
      console.error('POST /api/orders post-charge failure:', postChargeErr);
      let refunded = false;
      try {
        const r = await qbPayments.refund({
          chargeId:    chargedId,
          description: 'Order persistence failed; auto-refund.',
          requestId:   `auto-refund-${chargedId}`,
        });
        refunded = r?.ok !== false;
      } catch (refundErr) {
        console.error(`Auto-refund failed for charge ${chargedId}:`, refundErr);
      }
      return res.status(500).json({
        error: refunded
          ? 'Order creation failed after charge; your card has been refunded.'
          : 'Order creation failed and the refund attempt also failed — please contact support with your charge id.',
        charge_id: chargedId,
        detail:    postChargeErr.message,
      });
    }
  } catch (err) {
    // Pre-charge failure (validation, pricing, shipping quote, charge denial,
    // etc.). chargedId is null here — nothing to refund.
    console.error('POST /api/orders failed:', err);
    res.status(500).json({ error: 'Order creation failed', detail: err.message });
  }
});

// Fire-and-forget wrapper around the QBO sync helper. Throws are swallowed
// at the call site (line 423) — the order is already persisted and the
// card already charged, so a QBO sync failure must not surface as an error
// to the customer. Admin can re-run later: createSalesReceiptFromOrder is
// idempotent (skips if orders.qbo_invoice_id is already set).
async function queueQboSalesReceipt(orderId) {
  const { createSalesReceiptFromOrder } = require('../lib/qbo-sync');
  const qboId = await createSalesReceiptFromOrder(orderId);
  console.log(`[orders] QBO SalesReceipt ${qboId} created for order ${orderId}`);
}

// ═════════════════════════════════════════════════════════════════════════════
// GET /api/orders/:orderNumber
// Customer-facing order status view.
// ═════════════════════════════════════════════════════════════════════════════
router.get('/:orderNumber', requireCustomer, async (req, res) => {
  try {
    const order = await queryOne(
      `SELECT * FROM orders WHERE order_number = $1 AND client_id = $2`,
      [req.params.orderNumber, req.customer.id]
    );
    if (!order) return res.status(404).json({ error: 'Order not found' });

    const items       = await query(`SELECT * FROM order_items WHERE order_id = $1 ORDER BY id`, [order.id]);
    const decorations = await query(`SELECT * FROM order_decorations WHERE order_id = $1 ORDER BY id`, [order.id]);
    const designs     = await query(`SELECT * FROM designs WHERE order_id = $1 ORDER BY uploaded_at`, [order.id]);

    res.json({ order, items, decorations, designs });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/orders   (history for the logged-in customer)
router.get('/', requireCustomer, async (req, res) => {
  try {
    const orders = await query(
      `SELECT id, order_number, status, fulfillment_method, grand_total,
              created_at, paid_at, shipped_at, picked_up_at, cancelled_at
         FROM orders
        WHERE client_id = $1
        ORDER BY created_at DESC
        LIMIT 50`,
      [req.customer.id]
    );
    res.json({ orders });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
