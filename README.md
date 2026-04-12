# Holm Graphics API

Express + mssql backend connecting to **HolmGraphicsMain** on Azure SQL.

## Quick Start

```bash
# 1. Install
npm install

# 2. Set up environment
cp .env.example .env
# Edit .env — fill in DB_USER and confirm DB_PASSWORD

# 3. Run schema discovery (verify column names match)
node db/discover-schema.js

# 4. Run auth setup SQL in Azure Portal Query Editor
#    Copy/paste contents of: db/setup-auth.sql

# 5. Set employee passwords
node db/set-passwords.js

# 6. Start dev server
npm run dev
# → http://localhost:3000/api/health
```

## API Endpoints

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| POST | `/api/auth/login` | Public | Login → JWT |
| POST | `/api/auth/set-password` | Any | Set employee password |
| GET | `/api/projects` | Any | All projects (clients see own only) |
| GET | `/api/projects/:id` | Any | Single project + client info |
| POST | `/api/projects` | Staff | Create project |
| PUT | `/api/projects/:id` | Staff | Update project |
| GET | `/api/projects/:id/notes` | Any | Project notes |
| POST | `/api/projects/:id/notes` | Any | Add note |
| POST | `/api/projects/:id/status` | Staff | Change status + audit log |
| GET | `/api/projects/:id/items` | Any | Line items |
| GET | `/api/clients` | Staff | Search clients |
| GET | `/api/clients/:id` | Auth | Client detail + addresses + phones |
| GET | `/api/employees` | Staff | Employee list |
| GET | `/api/statuses` | Auth | Status lookup |
| GET | `/api/project-types` | Auth | Project type lookup |
| GET | `/api/health` | Public | Health check |

## If Column Names Don't Match

After running `node db/discover-schema.js`, compare the output to `db/column-map.js`.
Update the right-hand values in `column-map.js` — all routes read from there.

## Deploy to Railway

1. Push this folder to a GitHub repo
2. Create new Railway project → Deploy from GitHub
3. Add environment variables (same as .env, minus DB_PASSWORD which you set securely)
4. Railway auto-deploys on push

Connection string stays pointing at Azure SQL until you migrate the DB.
