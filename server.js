// server.js — Holm Graphics Shop API
require('dotenv').config();
const express = require('express');
const cors    = require('cors');
const path    = require('path');

const { runMigrations } = require('./db/migrate');

const authRoutes         = require('./routes/auth');
const projectRoutes      = require('./routes/projects');
const lookupRoutes       = require('./routes/lookup');
const quickbooksRoutes   = require('./routes/quickbooks');
const suppliersRoutes    = require('./routes/suppliers');
const catalogRoutes      = require('./routes/catalog');
const clientsRoutes      = require('./routes/clients');
const customerAuthRoutes = require('./routes/customer-auth');
const dtfConfigRoutes    = require('./routes/dtf-config');
const ordersRoutes       = require('./routes/orders');
const designsRoutes      = require('./routes/designs');
const proofsRoutes       = require('./routes/proofs');
const paymentRoutes      = require('./routes/payment');
const internalPaymentsRoutes = require('./routes/internal-payments');
const quoteRoutes        = require('./routes/quote');
const dtfAdminRoutes     = require('./routes/dtf-admin');
const ordersAdminRoutes  = require('./routes/orders-admin');
const uploadLinksRoutes  = require('./routes/upload-links');
const timeRoutes         = require('./routes/time');
const payPeriodsRoutes   = require('./routes/pay-periods');
const qboMatchRoutes     = require('./routes/qbo-employee-match');
const ledModulesRoutes   = require('./routes/led-modules');
const builderOrdersRoutes = require('./routes/builder-orders');
const fleetRoutes        = require('./routes/fleet');
const fleetSmartcarRoutes = require('./routes/fleet-smartcar');
const fleetFordproRoutes = require('./routes/fleet-fordpro');
const fleetTelematicsRoutes = require('./routes/fleet-telematics');
const cookieParser       = require('cookie-parser');
const quoteSheetRoutes   = require('./routes/quote-sheet');
const inboundEmailRoutes = require('./routes/inbound-email');
const projectProofsRoutes = require('./routes/project-proofs');
const { scheduleProofArchiveSweep } = require('./lib/proof-archive-sweep');
const { scheduleFordproPoll } = require('./lib/fordpro-telematics');
const schedulingRoutes    = require('./routes/scheduling');
const inventoryRoutes     = require('./routes/inventory');
// Telephony — inbound call screen pop (Phase 1). Owns BOTH the very short
// ingest paths the desk phones hit (/t/:token …) and the browser SSE stream
// (/api/telephony/stream), so it mounts at the app root rather than /api.
const telephonyRoutes     = require('./routes/telephony');
// Counter POS — Stripe Terminal. terminalRoutes is staff-authenticated and
// mounts under /api; stripeWebhookRoutes owns POST /webhooks/stripe at the
// app root because Stripe posts to a fixed URL with its own signature auth.
const terminalRoutes      = require('./routes/terminal');
const stripeWebhookRoutes = require('./routes/stripe-webhook');

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
// The `verify` hook stashes the raw request body on req.rawBody for
// routes that need to verify HMAC signatures over the exact bytes the
// sender signed (currently just /api/projects/messages/inbound for
// Resend Inbound webhooks). Negligible overhead — one buffer→string
// copy per request, never logged.
// Raise from body-parser's 100 KB default — proof annotations can hold
// hundreds of vector shapes, and big quote sheets are also JSON-heavy.
// Multipart uploads (proofs, photos) don't hit this parser because their
// content type is multipart/form-data; they go through multer's own limit.
app.use(express.json({
  limit: '5mb',
  verify: (req, _res, buf) => { req.rawBody = buf.toString('utf8'); },
}));
// FordConnect OAuth callback uses a signed state cookie for CSRF protection.
// Parser runs site-wide so future cookie-based flows just work.
app.use(cookieParser());

// ─── Routes ───────────────────────────────────────────────────────────────────
// Telephony first: the phone ingest paths are deliberately tiny (/t/:token)
// to stay under the Grandstream Action URL length ceiling, and mounting them
// ahead of everything else keeps them out of reach of any future catch-all.
app.use('/',               telephonyRoutes);
// Stripe webhook, also at the root. No CORS and no session auth — the
// stripe-signature header over the raw body IS the authentication.
app.use('/',               stripeWebhookRoutes);
app.use('/api/terminal',   terminalRoutes);
app.use('/api/auth',       authRoutes);
app.use('/api/customer',     customerAuthRoutes);
app.use('/api/dtf',          dtfConfigRoutes);
app.use('/api/orders',       ordersRoutes);
app.use('/api/designs',      designsRoutes);
app.use('/api/proofs',       proofsRoutes);
app.use('/api/payment',       paymentRoutes);
// /api/internal — public tokenize endpoint for holmgraphics.ca/advertise
// + shared-secret charge endpoint for led.holmgraphics.ca. Has its own CORS.
app.use('/api/internal',     internalPaymentsRoutes);
app.use('/api/quote-request', quoteRoutes);
app.use('/api/admin/dtf',    dtfAdminRoutes);
app.use('/api/admin/orders', ordersAdminRoutes);
app.use('/api/projects',   projectRoutes);
// Internal quoting worksheet (new) — mounted at /api so its routes read
// /api/projects/:id/quote-sheet. Order doesn't matter vs projectRoutes
// because there's no path collision (no /quote-sheet route in projects.js).
app.use('/api',            quoteSheetRoutes);
// Inbound email webhook (POST /api/projects/messages/inbound). Auth is
// via the X-Inbound-Secret header; see routes/inbound-email.js.
app.use('/api',            inboundEmailRoutes);
// Project proofs — staff upload + customer tokenized approval flow.
// Mounted at /api so its routes read /api/projects/:id/proofs and
// /api/proofs/by-token/:token. Token endpoints have no auth (token IS
// the auth) so order doesn't matter vs other routers.
app.use('/api',            projectProofsRoutes);
// Scheduling system — install calendar (Phase 1), per-job tasks (Phase 2),
// templates (Phase 3), resource conflict view (Phase 4). All staff-only.
app.use('/api',            schedulingRoutes);
// Inventory + PO system. Phase 1 = media rolls (vinyl). Mounted at /api
// so its routes live under /api/inventory/...
app.use('/api',            inventoryRoutes);
// /api/clients MUST be mounted BEFORE the generic /api (lookupRoutes) mount,
// otherwise lookup's catch-all `GET /clients/:id` eats `/api/clients/folder-mappings`
// (parsing "folder-mappings" as an integer id and crashing the query).
app.use('/api/clients',    clientsRoutes);
// uploadLinksRoutes serves both /api/jobs/:id/upload-links (staff) and
// /api/upload-links/:token[/upload] (public). Mount before lookupRoutes
// so its specific paths win over the catch-all.
app.use('/api',            uploadLinksRoutes);
app.use('/api',            lookupRoutes);
app.use('/api/quickbooks', quickbooksRoutes);
app.use('/api/qbo-match',  qboMatchRoutes);
app.use('/api/suppliers',  suppliersRoutes);
app.use('/api/catalog',    catalogRoutes);
app.use('/api/time',         timeRoutes);
app.use('/api/pay-periods',  payPeriodsRoutes);
app.use('/api/led-modules',  ledModulesRoutes);
app.use('/api/builder',      builderOrdersRoutes);
// Smartcar telematics mounted BEFORE the generic fleet router so its
// specific paths (e.g. /vehicles/:id/location) win over /vehicles/:id.
app.use('/api/fleet',        fleetSmartcarRoutes);
// Ford Pro Telematics (M2M) at /api/fleet/fordpro/... — specific paths so
// they don't collide with the generic /fleet/vehicles handlers below.
app.use('/api',              fleetFordproRoutes);
// Provider-agnostic telematics read layer at /api/fleet/telematics/...
app.use('/api',              fleetTelematicsRoutes);
app.use('/api/fleet',        fleetRoutes);

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

// ─── Admin UI Pages ────────────────────────────────────────────────────────────
// Serve QBO employee matching UI for admins
app.get('/admin-legacy/qbo-match-employees.html', (req, res) => {
  res.sendFile(path.join(__dirname, 'lib/qbo-match-employees.html'));
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

  // Background: nightly proof archive sweep (deletes >90-day-old
  // superseded proof files from WHC). Self-scheduling, never blocks
  // request handling. See lib/proof-archive-sweep.js.
  scheduleProofArchiveSweep();

  // Background: Ford Pro Telematics poll (location/odometer/fuel every
  // FORD_TELEMATICS_POLL_MINUTES). Self-scheduling; no-ops until the
  // service-account creds are set. See lib/fordpro-telematics.js.
  scheduleFordproPoll();

  app.listen(PORT, () => {
    let dbHost = '(DATABASE_URL not set)';
    if (process.env.DATABASE_URL) {
      try {
        const u = new URL(process.env.DATABASE_URL);
        dbHost = `${u.hostname}:${u.port}/${u.pathname.slice(1)}`;
      } catch { dbHost = '(invalid DATABASE_URL)'; }
    }
    console.log(`Holm Graphics API listening on port ${PORT}`);
    console.log(`   Health:     http://localhost:${PORT}/api/health`);
    console.log(`   Photos:     ${process.env.WHC_PUBLIC_BASE || '(WHC_PUBLIC_BASE unset)'}`);
    console.log(`   Postgres:   ${dbHost}\n`);
  });
})();
