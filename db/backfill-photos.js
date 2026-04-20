// db/backfill-photos.js
// One-time backfill. Walks every job folder on WHC under
// $WHC_REMOTE_BASE/* and inserts a project_photos row for each file
// that doesn't already have one.
//
//   category=other, show_in_gallery=false, uploaded_by=null
//
// Re-runnable: uses (project_id, filename) unique key.
//
// Usable both as CLI (node db/backfill-photos.js) and as a module
// (exports runBackfill — called by POST /api/projects/admin/backfill-photos).
require('dotenv').config();
const ftp   = require('basic-ftp');
const { pool, query } = require('./connection');

function envConfig() {
  return {
    host:     process.env.WHC_FTP_HOST,
    port:     parseInt(process.env.WHC_FTP_PORT || '21', 10),
    user:     process.env.WHC_FTP_USER,
    pass:     process.env.WHC_FTP_PASSWORD,
    secure:   process.env.WHC_FTP_SECURE !== 'false',
    remoteBase: (process.env.WHC_REMOTE_BASE || 'public_html/shop-uploads/jobs').replace(/\/$/, ''),
  };
}

async function connect(cfg) {
  const c = new ftp.Client(30000);
  c.ftp.verbose = false;
  await c.access({
    host: cfg.host, port: cfg.port,
    user: cfg.user, password: cfg.pass,
    secure: cfg.secure,
    secureOptions: cfg.secure ? { checkServerIdentity: () => undefined } : undefined,
  });
  return c;
}

// Returns {jobsSeen, filesSeen, inserted, skippedExisting, skippedNoProject}
async function runBackfill({ log = () => {} } = {}) {
  const cfg = envConfig();
  if (!cfg.host || !cfg.user || !cfg.pass) {
    throw new Error('WHC_FTP_* env vars not set');
  }

  log(`Connecting to ${cfg.host} ...`);
  const client = await connect(cfg);
  try {
    log(`Walking ${cfg.remoteBase} ...`);
    let jobDirs;
    try {
      jobDirs = await client.list(cfg.remoteBase);
    } catch (e) {
      throw new Error(`Cannot list ${cfg.remoteBase}: ${e.message}`);
    }

    const stats = { jobsSeen: 0, filesSeen: 0, inserted: 0, skippedExisting: 0, skippedNoProject: 0 };

    for (const d of jobDirs) {
      if (!d.isDirectory) continue;
      const projectId = parseInt(d.name, 10);
      if (!Number.isInteger(projectId)) {
        log(`  [skip dir] ${d.name} — not numeric`);
        continue;
      }
      stats.jobsSeen++;

      const exists = await query(`SELECT 1 FROM projects WHERE id = $1`, [projectId]);
      if (exists.length === 0) {
        stats.skippedNoProject++;
        log(`  [skip job] ${projectId} — no matching project`);
        continue;
      }

      const remoteDir = `${cfg.remoteBase}/${projectId}`;
      let files;
      try { files = await client.list(remoteDir); }
      catch (e) { log(`  [skip job] ${projectId} — ${e.message}`); continue; }

      for (const f of files) {
        if (!f.isFile) continue;
        stats.filesSeen++;
        try {
          const result = await query(
            `INSERT INTO project_photos (project_id, filename, category, show_in_gallery)
             VALUES ($1, $2, 'other', FALSE)
             ON CONFLICT (project_id, filename) DO NOTHING
             RETURNING id`,
            [projectId, f.name]
          );
          if (result.length > 0) stats.inserted++;
          else stats.skippedExisting++;
        } catch (e) {
          log(`  [fail] job ${projectId} / ${f.name}: ${e.message}`);
        }
      }
    }

    log(`
Done.
  job folders scanned:       ${stats.jobsSeen}
  files found on WHC:        ${stats.filesSeen}
  rows inserted:             ${stats.inserted}
  rows already present:      ${stats.skippedExisting}
  folders w/o project row:   ${stats.skippedNoProject}
`);
    return stats;
  } finally {
    client.close();
  }
}

module.exports = { runBackfill };

// CLI entry point.
if (require.main === module) {
  runBackfill({ log: console.log })
    .then(() => pool.end())
    .catch((e) => { console.error(e.message); pool.end(); process.exit(1); });
}
