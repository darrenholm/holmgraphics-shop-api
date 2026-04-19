// server.js — Holm Graphics Shop API
require('dotenv').config();
const express = require('express');
const cors    = require('cors');
const path    = require('path');
const fs      = require('fs');

const authRoutes       = require('./routes/auth');
const projectRoutes    = require('./routes/projects');
const lookupRoutes     = require('./routes/lookup');
const quickbooksRoutes = require('./routes/quickbooks');

const app  = express();
const PORT = process.env.PORT || 3000;

// ─── Ensure uploads folder exists ─────────────────────────────────────────────
if (!fs.existsSync('uploads')) fs.mkdirSync('uploads');
if (!fs.existsSync('uploads/jobs')) fs.mkdirSync('uploads/jobs');

// ─── CORS ─────────────────────────────────────────────────────────────────────
const allowedOrigins = (process.env.CORS_ORIGINS || 'http://localhost:5173')
  .split(',').map(o => o.trim());

app.use(cors({
  origin: (origin, cb) => {
    if (!origin) return cb(null, true);
    if (allowedOrigins.includes(origin)) return cb(null, true);
    cb(new Error(`CORS blocked: ${origin}`));
  },
  credentials: true,
}));

// ─── Body parsing ─────────────────────────────────────────────────────────────
app.use(express.json());

// ─── Static uploads ───────────────────────────────────────────────────────────
app.use('/uploads', express.static(path.join(__dirname, 'uploads')));

// ─── Routes ───────────────────────────────────────────────────────────────────
app.use('/api/auth',       authRoutes);
app.use('/api/projects',   projectRoutes);
app.use('/api',            lookupRoutes);
app.use('/api/quickbooks', quickbooksRoutes);

// ─── Health check ─────────────────────────────────────────────────────────────
app.get('/api/health', (req, res) => {
  // Strip credentials from DATABASE_URL before reporting.
  let dbHost = '(unset)';
  if (process.env.DATABASE_URL) {
    try {
      const u = new URL(process.env.DATABASE_URL);
      dbHost = `${u.hostname}:${u.port}/${u.pathname.slice(1)}`;
    } catch { dbHost = '(invalid DATABASE_URL)'; }
  }
  res.json({
    status: 'ok',
    service: 'holmgraphics-api',
    timestamp: new Date().toISOString(),
    db: dbHost,
  });
});

// ─── 404 ──────────────────────────────────────────────────────────────────────
app.use((req, res) => {
  res.status(404).json({ message: `Route not found: ${req.method} ${req.path}` });
});

// ─── Error handler ────────────────────────────────────────────────────────────
app.use((err, req, res, next) => {
  console.error('Unhandled error:', err);
  res.status(500).json({ message: 'Internal server error' });
});

// ─── Start ────────────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  let dbHost = '(DATABASE_URL not set)';
  if (process.env.DATABASE_URL) {
    try {
      const u = new URL(process.env.DATABASE_URL);
      dbHost = `${u.hostname}:${u.port}/${u.pathname.slice(1)}`;
    } catch { dbHost = '(invalid DATABASE_URL)'; }
  }
  console.log(`\nHolm Graphics API running on port ${PORT}`);
  console.log(`   Health:     http://localhost:${PORT}/api/health`);
  console.log(`   Uploads:    http://localhost:${PORT}/uploads`);
  console.log(`   Postgres:   ${dbHost}\n`);
});
