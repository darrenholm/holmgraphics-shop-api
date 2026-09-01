// lib/inspection-jobs.js
// Scheduled automation for daily vehicle inspections (build spec §7).
//
// Inspections are driver-initiated by law — nothing here can complete one,
// and nothing here should ever try. What it does is make the gaps visible:
//
//   inspection-daily-digest  07:00 Mon–Fri  in-scope units with work booked
//                                           today and no valid inspection
//   fleet-expiry-digest      07:00 Monday   vehicle documents expiring
//                                           within 30 days, or already gone
//   inspection-retention     06:00, 1st     archive reports past their
//                                           retention window (never delete)
//
// Scheduling model: the other background jobs in this API (proof-archive
// sweep, Ford Pro poll) use a setInterval measured from process boot, which
// cannot express "07:00 on a weekday" — Railway redeploys reset the phase to
// whenever the deploy happened. So this ticks every few minutes and asks the
// database whether the current period's run has been claimed yet. See
// migration 061 for why the claim is an INSERT.
//
// All times are shop-local (America/Toronto), not UTC. Railway runs in UTC,
// so "07:00" here means 11:00 or 12:00 UTC depending on daylight time, and
// deriving it from the wall clock rather than a fixed offset is the only way
// that stays correct across the March and November changeovers.

'use strict';

const { query, queryOne } = require('../db/connection');
const mailer = require('./customer-mailer');

const SHOP_TZ = 'America/Toronto';

// How often the scheduler wakes up. Small enough that a job fires close to
// its nominal time, large enough that it is not a meaningful load.
const TICK_MINUTES = Number(process.env.INSPECTION_JOB_TICK_MINUTES || 5);

// Retention windows from the regulation.
const RETAIN_MONTHS_PLAIN  = 6;   // ordinary report
const RETAIN_MONTHS_REPAIR = 24;  // report with a repair against it

// ─── shop-local clock helpers ──────────────────────────────────────────
// Intl is the only thing in the standard library that knows Toronto's DST
// rules. Doing this with a fixed -5/-4 offset would be wrong twice a year.

const PARTS_FMT = new Intl.DateTimeFormat('en-CA', {
  timeZone: SHOP_TZ,
  year: 'numeric', month: '2-digit', day: '2-digit',
  hour: '2-digit', minute: '2-digit', weekday: 'short',
  hour12: false,
});

function shopNow(at = new Date()) {
  const parts = {};
  for (const p of PARTS_FMT.formatToParts(at)) parts[p.type] = p.value;
  // hour can come back as '24' at midnight in some ICU versions.
  const hour = Number(parts.hour) % 24;
  return {
    date:    `${parts.year}-${parts.month}-${parts.day}`,
    month:   `${parts.year}-${parts.month}`,
    year:    Number(parts.year),
    day:     Number(parts.day),
    hour,
    minute:  Number(parts.minute),
    weekday: parts.weekday,                             // 'Mon' … 'Sun'
    isWeekday: !['Sat', 'Sun'].includes(parts.weekday),
  };
}

// ISO week key, e.g. '2026-W36'. Used so the weekly digest claims one run
// per week regardless of which day the process happened to be alive on.
function isoWeekKey(dateStr) {
  const [y, m, d] = dateStr.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  // Thursday of the current ISO week decides the year and week number.
  const dayNum = (dt.getUTCDay() + 6) % 7;
  dt.setUTCDate(dt.getUTCDate() - dayNum + 3);
  const isoYear = dt.getUTCFullYear();
  const firstThu = new Date(Date.UTC(isoYear, 0, 4));
  const firstDayNum = (firstThu.getUTCDay() + 6) % 7;
  firstThu.setUTCDate(firstThu.getUTCDate() - firstDayNum + 3);
  const week = 1 + Math.round((dt - firstThu) / (7 * 86400000));
  return `${isoYear}-W${String(week).padStart(2, '0')}`;
}

// ─── run claiming ──────────────────────────────────────────────────────

// Returns true if THIS process won the right to run (job, period). The
// INSERT is the lock: a second tick, a second replica, or a redeploy mid-
// window all lose the race and skip. Never throws — a scheduler that can
// crash the boot sequence is worse than one that misses a digest.
async function claimRun(jobName, runKey) {
  try {
    const rows = await query(
      `INSERT INTO scheduled_job_runs (job_name, run_key)
       VALUES ($1, $2)
       ON CONFLICT (job_name, run_key) DO NOTHING
       RETURNING job_name`,
      [jobName, runKey]
    );
    return rows.length > 0;
  } catch (e) {
    console.warn(`[inspection-jobs] could not claim ${jobName}/${runKey}:`, e.message);
    return false;
  }
}

async function finishRun(jobName, runKey, ok, detail) {
  try {
    await query(
      `UPDATE scheduled_job_runs
          SET finished_at = NOW(), ok = $3, detail = $4::jsonb
        WHERE job_name = $1 AND run_key = $2`,
      [jobName, runKey, ok, JSON.stringify(detail || {})]
    );
  } catch (e) {
    console.warn(`[inspection-jobs] could not finish ${jobName}/${runKey}:`, e.message);
  }
}

// ─── queries ───────────────────────────────────────────────────────────

// Units on a DAILY policy without a currently-valid inspection.
//
// Keyed on inspection_policy, not on inspection_required: the operator runs
// checks on demand (in practice when towing), so a unit the regulation
// covers is not "overdue" merely because a day passed. Switching a unit to
// 'daily' is what opts it into this digest. `has_work_today` is
// resolved through resources.vehicle_id (migration 041) → job_tasks, which
// is how a truck gets onto the schedule board. The digest reports both, but
// leads with the units that have work booked — those are the ones where a
// missing check actually stops something today.
async function unitsNeedingInspection() {
  return query(
    `SELECT v.id, v.unit_number, v.license_plate, v.make, v.model, v.year,
            latest.completed_at AS last_completed_at,
            latest.valid_until  AS last_valid_until,
            latest.inspector_name,
            COALESCE(work.n, 0) > 0 AS has_work_today,
            COALESCE(major.n, 0)    AS open_major_defects
       FROM vehicles v
       LEFT JOIN LATERAL (
         SELECT i.completed_at, i.valid_until, i.inspector_name
           FROM inspections i
          WHERE i.vehicle_id = v.id
            AND i.completed_at IS NOT NULL
            AND i.deleted_at IS NULL
            AND i.status <> 'superseded'
          ORDER BY i.completed_at DESC
          LIMIT 1
       ) latest ON TRUE
       LEFT JOIN LATERAL (
         SELECT COUNT(*)::int AS n
           FROM job_tasks t
           JOIN resources r ON r.id = t.resource_id
          WHERE r.vehicle_id = v.id
            AND t.status NOT IN ('completed', 'skipped')
            AND t.planned_start IS NOT NULL
            AND CURRENT_DATE BETWEEN t.planned_start
                                 AND COALESCE(t.planned_end, t.planned_start)
       ) work ON TRUE
       LEFT JOIN LATERAL (
         SELECT COUNT(*)::int AS n
           FROM inspection_defects d
           JOIN inspections i2 ON i2.id = d.inspection_id
          WHERE i2.vehicle_id = v.id
            AND i2.deleted_at IS NULL
            AND i2.completed_at IS NOT NULL
            AND d.severity = 'major'
            AND d.resolved_at IS NULL
       ) major ON TRUE
      WHERE v.active = TRUE
        AND v.inspection_policy = 'daily'
        AND (latest.valid_until IS NULL OR latest.valid_until <= NOW())
      ORDER BY (COALESCE(work.n, 0) > 0) DESC, v.unit_number`
  );
}

async function unitsOutOfService() {
  return query(
    `SELECT DISTINCT v.id, v.unit_number, v.license_plate,
            COUNT(*)::int AS open_major_defects
       FROM inspection_defects d
       JOIN inspections i ON i.id = d.inspection_id
       JOIN vehicles v    ON v.id = i.vehicle_id
      WHERE d.severity = 'major'
        AND d.resolved_at IS NULL
        AND i.deleted_at IS NULL
        AND i.completed_at IS NOT NULL
        AND v.active = TRUE
      GROUP BY v.id, v.unit_number, v.license_plate
      ORDER BY v.unit_number`
  );
}

// Documents already expired, or expiring inside the window. Includes an
// annual-inspection row that is missing entirely on an in-scope unit,
// because "no document on file" is the gap an audit finds first.
async function expiringDocuments(windowDays = 30) {
  return query(
    `SELECT v.unit_number, v.license_plate, v.inspection_required,
            d.doc_type, d.expiry_date,
            (d.expiry_date - CURRENT_DATE) AS days_remaining
       FROM fleet_documents d
       JOIN vehicles v ON v.id = d.vehicle_id
      WHERE d.is_current = TRUE
        AND v.active = TRUE
        AND d.expiry_date IS NOT NULL
        AND d.expiry_date <= CURRENT_DATE + ($1::int || ' days')::interval
      ORDER BY d.expiry_date`,
    [windowDays]
  );
}

async function missingDocuments() {
  return query(
    `SELECT v.unit_number, v.license_plate, v.inspection_required, t.doc_type
       FROM vehicles v
       CROSS JOIN (VALUES ('insurance'), ('inspection')) AS t(doc_type)
      WHERE v.active = TRUE
        AND NOT EXISTS (
          SELECT 1 FROM fleet_documents d
           WHERE d.vehicle_id = v.id
             AND d.doc_type = t.doc_type
             AND d.is_current = TRUE
        )
      ORDER BY v.unit_number, t.doc_type`
  );
}

// ─── jobs ──────────────────────────────────────────────────────────────

async function runDailyDigest({ force = false } = {}) {
  const now = shopNow();
  const runKey = now.date;
  if (!force && !(await claimRun('inspection-daily-digest', runKey))) {
    return { skipped: 'already_ran', runKey };
  }

  try {
    const [needing, oos] = await Promise.all([unitsNeedingInspection(), unitsOutOfService()]);
    // Nothing wrong and nothing out of service: say nothing. A digest that
    // arrives every morning saying "all good" stops being read by week two,
    // and then the one that matters is not read either.
    const worthSending = needing.length > 0 || oos.length > 0;
    let sent = null;
    if (worthSending) {
      sent = await mailer.sendInspectionDailyDigest({ needing, outOfService: oos, date: now.date });
    }
    const detail = { needing: needing.length, out_of_service: oos.length, sent: !!sent?.sent };
    if (!force) await finishRun('inspection-daily-digest', runKey, true, detail);
    return { ...detail, runKey };
  } catch (e) {
    if (!force) await finishRun('inspection-daily-digest', runKey, false, { error: e.message });
    throw e;
  }
}

async function runExpiryDigest({ force = false } = {}) {
  const now = shopNow();
  const runKey = isoWeekKey(now.date);
  if (!force && !(await claimRun('fleet-expiry-digest', runKey))) {
    return { skipped: 'already_ran', runKey };
  }

  try {
    const [expiring, missing] = await Promise.all([expiringDocuments(30), missingDocuments()]);
    let sent = null;
    if (expiring.length > 0 || missing.length > 0) {
      sent = await mailer.sendFleetDocumentExpiryDigest({ expiring, missing });
    }
    const detail = { expiring: expiring.length, missing: missing.length, sent: !!sent?.sent };
    if (!force) await finishRun('fleet-expiry-digest', runKey, true, detail);
    return { ...detail, runKey };
  } catch (e) {
    if (!force) await finishRun('fleet-expiry-digest', runKey, false, { error: e.message });
    throw e;
  }
}

// Archive, never delete. A report with a repair recorded against it is a
// maintenance record and lives four times as long.
async function runRetentionArchive({ force = false } = {}) {
  const now = shopNow();
  const runKey = now.month;
  if (!force && !(await claimRun('inspection-retention', runKey))) {
    return { skipped: 'already_ran', runKey };
  }

  try {
    const rows = await query(
      `UPDATE inspections i
          SET archived_at = NOW()
        WHERE i.archived_at IS NULL
          AND i.completed_at IS NOT NULL
          AND i.deleted_at IS NULL
          AND i.completed_at < NOW() - (
                CASE WHEN EXISTS (
                  SELECT 1 FROM inspection_defects d
                   WHERE d.inspection_id = i.id AND d.resolved_at IS NOT NULL
                ) THEN $2::int ELSE $1::int END || ' months')::interval
        RETURNING i.id`,
      [RETAIN_MONTHS_PLAIN, RETAIN_MONTHS_REPAIR]
    );
    const detail = { archived: rows.length };
    if (!force) await finishRun('inspection-retention', runKey, true, detail);
    return { ...detail, runKey };
  } catch (e) {
    if (!force) await finishRun('inspection-retention', runKey, false, { error: e.message });
    throw e;
  }
}

// ─── scheduler ─────────────────────────────────────────────────────────

// One tick: check each job's window and let claimRun() decide whether it
// actually fires. Windows are "at or after" rather than "exactly at", so a
// deploy that misses 07:00 still sends the digest when it comes back up
// — a late digest is useful, a skipped one is not.
async function tick() {
  const now = shopNow();
  try {
    if (now.isWeekday && now.hour >= 7) {
      await runDailyDigest();
    }
    if (now.weekday === 'Mon' && now.hour >= 7) {
      await runExpiryDigest();
    }
    if (now.day === 1 && now.hour >= 6) {
      await runRetentionArchive();
    }
  } catch (e) {
    console.warn('[inspection-jobs] tick threw:', e.message || e);
  }
}

function scheduleInspectionJobs() {
  const BOOT_DELAY_MS = 2 * 60 * 1000;
  const PERIOD_MS = TICK_MINUTES * 60 * 1000;
  setTimeout(() => {
    tick();
    setInterval(tick, PERIOD_MS);
  }, BOOT_DELAY_MS);
  console.log(`[inspection-jobs] scheduler ticking every ${TICK_MINUTES} min (${SHOP_TZ})`);
}

module.exports = {
  scheduleInspectionJobs,
  runDailyDigest,
  runExpiryDigest,
  runRetentionArchive,
  unitsNeedingInspection,
  unitsOutOfService,
  _internals: { shopNow, isoWeekKey, claimRun, SHOP_TZ },
};
