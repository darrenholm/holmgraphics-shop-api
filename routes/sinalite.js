// routes/sinalite.js
//
// Staff-only SinaLite price lookups for the job page quote sheet.
// Mounted at /api/sinalite. Nothing here places an order.

'use strict';

const express = require('express');
const { requireStaff } = require('../middleware/auth');
const sinalite = require('../suppliers/sinalite/client');

const router = express.Router();

// Shop address — default ship-to for shipping estimates.
const SHOP_DEST = { zip: 'N0G 2V0', state: 'ON', country: 'CA' };

function productIdOrBail(req, res) {
  const id = parseInt(req.params.id, 10);
  if (!Number.isInteger(id) || id <= 0) {
    res.status(400).json({ message: 'invalid product id' });
    return null;
  }
  return id;
}

function optionIdsOrBail(req, res) {
  const ids = (req.body && req.body.optionIds) || [];
  if (!Array.isArray(ids) || ids.length === 0 || !ids.every((n) => Number.isInteger(Number(n)))) {
    res.status(400).json({ message: 'optionIds must be a non-empty list of option ids' });
    return null;
  }
  return ids.map(Number);
}

function sendError(res, err) {
  console.error('sinalite:', err.message);
  res.status(err.status || 500).json({ message: err.message });
}

// ─── GET /api/sinalite/status ────────────────────────────────────────────
router.get('/status', requireStaff, (req, res) => {
  const cfg = sinalite.loadConfig();
  res.json({ configured: sinalite.isConfigured(cfg), env: cfg.env });
});

// ─── GET /api/sinalite/products ──────────────────────────────────────────
router.get('/products', requireStaff, async (req, res) => {
  try {
    res.json({ products: await sinalite.listProducts(), env: sinalite.loadConfig().env });
  } catch (err) { sendError(res, err); }
});

// ─── GET /api/sinalite/products/:id/options ──────────────────────────────
router.get('/products/:id/options', requireStaff, async (req, res) => {
  const id = productIdOrBail(req, res);
  if (id == null) return;
  try {
    res.json(await sinalite.getProductOptions(id));
  } catch (err) { sendError(res, err); }
});

// ─── POST /api/sinalite/products/:id/price ───────────────────────────────
// Body: { optionIds: [..] } — one option id from each group.
router.post('/products/:id/price', requireStaff, async (req, res) => {
  const id = productIdOrBail(req, res);
  if (id == null) return;
  const optionIds = optionIdsOrBail(req, res);
  if (!optionIds) return;
  try {
    res.json(await sinalite.getPrice(id, optionIds));
  } catch (err) { sendError(res, err); }
});

// ─── POST /api/sinalite/products/:id/shipping ────────────────────────────
// Body: { optionIds: [..], zip?, state?, country? } — defaults to the shop.
router.post('/products/:id/shipping', requireStaff, async (req, res) => {
  const id = productIdOrBail(req, res);
  if (id == null) return;
  const optionIds = optionIdsOrBail(req, res);
  if (!optionIds) return;
  const b = req.body || {};
  const dest = {
    zip: String(b.zip || SHOP_DEST.zip).trim().toUpperCase(),
    state: String(b.state || SHOP_DEST.state).trim().toUpperCase(),
    country: String(b.country || SHOP_DEST.country).trim().toUpperCase(),
  };
  try {
    res.json({ rates: await sinalite.getShippingEstimate(id, optionIds, dest), dest });
  } catch (err) { sendError(res, err); }
});

module.exports = router;
