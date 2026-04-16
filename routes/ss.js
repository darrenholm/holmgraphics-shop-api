/**
 * S&S Canada Apparel API
 * Route: /api/ss
 */

const express = require('express');
const router = express.Router();

const SS_BASE = 'https://api-ca.ssactivewear.com/v2';
const SS_ACCOUNT = process.env.SS_ACCOUNT || '001946';
const SS_API_KEY = process.env.SS_API_KEY || '';

function ssHeaders() {
  const creds = Buffer.from(`${SS_ACCOUNT}:${SS_API_KEY}`).toString('base64');
  return {
    'Authorization': `Basic ${creds}`,
    'Accept': 'application/json'
  };
}

async function ssGet(path) {
  const res = await fetch(`${SS_BASE}${path}`, { headers: ssHeaders() });
  if (!res.ok) throw new Error(`S&S API ${res.status}: ${await res.text()}`);
  return res.json();
}

// GET /api/ss/styles?search=gildan hoodie
router.get('/styles', async (req, res) => {
  try {
    const { search } = req.query;
    if (!search) return res.status(400).json({ error: 'search query required' });
    const data = await ssGet(`/styles?search=${encodeURIComponent(search)}`);
    res.json(data);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// GET /api/ss/products?style=00760
router.get('/products', async (req, res) => {
  try {
    const { style, partnumber } = req.query;
    if (!style && !partnumber) return res.status(400).json({ error: 'style or partnumber required' });
    const param = style ? `style=${encodeURIComponent(style)}` : `partnumber=${encodeURIComponent(partnumber)}`;
    const data = await ssGet(`/products/?${param}`);
    res.json(data);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// GET /api/ss/status — check if API key is configured
router.get('/status', (req, res) => {
  res.json({
    configured: !!SS_API_KEY,
    account: SS_ACCOUNT
  });
});

module.exports = router;
