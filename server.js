// server.js — Holm Graphics Shop API
require('dotenv').config();
const express = require('express');
const cors    = require('cors');

const { runMigrations } = require('./db/migrate');

const authRoutes       = require('./routes/auth');
const projectRoutes    = require('./routes/projects');
const lookupRoutes     = require('./routes/lookup');
const quickbooksRoutes = require('./routes/quickbooks');
const suppliersRoutes  = require('./routes/suppliers');
const catalogRoutes    = require('./routes/catalog');

const app  = express();
const PORT = process.env.PORT || 3000;

// Job photos are stored on WHC (see routes/projects.js), not on this server's
// local disk — Railway's filesystem is ephemeral. No local uploads folder.

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

// ─── Routes ───────────────────────────────────────────────────────────────────
app.use('/api/auth',       authRoutes);
app.use('/api/projects',   projectRoutes);
app.use('/api',            lookupRoutes);
app.use('/api/quickbooks', quickbooksRoutes);
app.use('/api/suppliers',  suppliersRoutes);
app.use('/api/catalog',    catalogRoutes);

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
// Apply any pending SQL migrations BEFORE we start serving requests, so
// handlers never hit a missing table.
(async () => {
  try {
    await runMigrations();
  } catch (e) {
    console.error('FATAL: migrations failed —', e.message);
    process.exit(1);
  }

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
    console.log(`   Photos:     ${process.env.WHC_PUBLIC_BASE || '(WHC_PUBLIC_BASE unset)'}`);
    console.log(`   Postgres:   ${dbHost}\n`);
  });
})();
