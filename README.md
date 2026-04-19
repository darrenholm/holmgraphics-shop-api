# Holm Graphics API

Express + Postgres backend talking to **HolmGraphicsMain** on Railway Postgres.

(Formerly pointed at Azure SQL `holmgraphics.database.windows.net`. See
`../holmgraphics-shop/docs/db-migration/` in the shop repo for the migration
history and scripts.)

## Quick Start

```bash
# 1. Install
npm install

# 2. Set up environment
cp .env.example .env
# Edit .env: set DATABASE_URL to the Railway public proxy URL
# (Dashboard → Postgres → Connect → DATABASE_PUBLIC_URL)

# 3. Optional: inspect the live schema
node db/discover-schema.js

# 4. Set employee passwords (first time only)
node db/set-passwords.js

# 5. Start dev server
npm run dev
# → http://localhost:3000/api/health
```

## Environment

- `DATABASE_URL` — Postgres connection string. In production (Railway), this
  is auto-injected when the Postgres plugin is attached. For local dev, use
  the **public** proxy URL from Railway dashboard (it ends in `.rlwy.net`),
  not the internal one.
- `JWT_SECRET` — used to sign login tokens.
- `JWT_EXPIRES_IN` — optional, defaults to `8h`.
- `CORS_ORIGINS` — comma-separated list of allowed origins.
- `PORT` — HTTP port, defaults to 3000.

## API Endpoints

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| POST | `/api/auth/login` | Public | Login → JWT |
| POST | `/api/auth/set-password` | Any | Set employee password |
| POST | `/api/auth/change-password` | Auth | Change own password |
| GET | `/api/projects` | Any | All projects (clients see own only) |
| GET | `/api/projects/:id` | Any | Single project + client info |
| POST | `/api/projects` | Staff | Create project |
| PUT | `/api/projects/:id` | Staff | Update project |
| GET | `/api/projects/:id/notes` | Any | Project notes |
| POST | `/api/projects/:id/notes` | Any | Add note |
| POST | `/api/projects/:id/status` | Staff | Change status + audit log |
| GET | `/api/projects/:id/items` | Any | Line items |
| POST | `/api/projects/:id/items` | Staff | Add line item |
| POST | `/api/projects/:id/measurements` | Staff | Add measurement |
| GET | `/api/projects/:id/photos` | Any | Photos (filesystem) |
| POST | `/api/projects/:id/photos` | Staff | Upload photos |
| DELETE | `/api/projects/:id/photos/:filename` | Staff | Delete photo |
| GET | `/api/clients` | Staff | Search clients |
| GET | `/api/clients/:id` | Auth | Client detail + addresses + phones |
| POST | `/api/clients` | Staff | Create client |
| GET | `/api/employees` | Staff | Employee list |
| GET | `/api/statuses` | Auth | Status lookup |
| GET | `/api/project-types` | Auth | Project type lookup |
| GET | `/api/health` | Public | Health check |

## If column names don't match what routes expect

Run `node db/discover-schema.js` and compare the output to the SQL in
`routes/*.js`. Queries use direct `snake_case` column names — there's no
column-map indirection anymore (removed during the Postgres cutover;
Railway's schema is stable enough not to need it).

## Deploy to Railway

1. Push to a GitHub repo.
2. In Railway, create the service from GitHub.
3. Attach the Postgres plugin — this auto-injects `DATABASE_URL`.
4. Set `JWT_SECRET` and `CORS_ORIGINS` manually in the service's Variables tab.
5. Railway auto-deploys on push.
