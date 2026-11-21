// Operations: backups (both databases), error log + alerts, and a system status report.
import { DatabaseSync } from "node:sqlite";
import { createReadStream, createWriteStream, existsSync, mkdirSync, readdirSync, statSync, unlinkSync } from "node:fs";
import { createGzip, createGunzip } from "node:zlib";
import { createInterface } from "node:readline";
import { once } from "node:events";
import { join } from "node:path";
import { TABLES, MIGRATIONS, sqlNow, sqlDaysAgo } from "./db.js";

export const BACKUP_PREFIX = "agriconnect-";
const SCHEMA_VERSION = Math.max(...MIGRATIONS.map((m) => m.version));

// ---------------------------------------------------------------- backups
//
// SQLite      → agriconnect-YYYYMMDD-HHMMSS.db       (an exact copy, "VACUUM INTO")
// PostgreSQL  → agriconnect-YYYYMMDD-HHMMSS.jsonl.gz (every row of every table, compressed)
//
// Both kinds are checked right after they are made, and both can be restored into
// either database (this is also how a laptop's SQLite data moves to PostgreSQL).

const stampOf = (now) => now.toISOString().replace(/[-:]/g, "").replace("T", "-").slice(0, 15); // 20261120-170600

export async function backupDatabase(db, dir, { now = new Date(), keep = 14 } = {}) {
  mkdirSync(dir, { recursive: true });
  let file;
  let expected = null;
  if (db.dialect === "sqlite") {
    file = join(dir, `${BACKUP_PREFIX}${stampOf(now)}.db`);
    if (existsSync(file)) unlinkSync(file);
    await db.exec(`VACUUM INTO '${file.replace(/'/g, "''")}'`);
  } else {
    file = join(dir, `${BACKUP_PREFIX}${stampOf(now)}.jsonl.gz`);
    expected = await exportJsonl(db, file, now);
  }
  const check = await verifyBackup(file, expected);
  await db.run("INSERT INTO backups (file, bytes, ok, detail, created_at) VALUES (?, ?, ?, ?, ?)",
    file, check.bytes, check.ok ? 1 : 0, JSON.stringify(check), now.toISOString());

  // Keep the newest `keep` backups.
  const removed = [];
  for (const old of listBackupFiles(dir).slice(keep)) { unlinkSync(join(dir, old.name)); removed.push(old.name); }
  return { file, ...check, removed };
}

/** Write every row of every table as JSON lines (first line: a header). Returns rows per table. */
async function exportJsonl(db, file, now) {
  const gz = createGzip();
  const out = createWriteStream(file);
  gz.pipe(out);
  const write = async (obj) => { if (!gz.write(JSON.stringify(obj) + "\n")) await once(gz, "drain"); };
  const counts = {};
  await write({ format: "agriconnect-backup", version: 1, schema_version: SCHEMA_VERSION, from: db.dialect, created_at: now.toISOString() });
  // One transaction, so the copy is consistent even while the server keeps working.
  await db.tx(async (t) => {
    if (t.dialect === "postgres") await t.exec("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY");
    for (const table of TABLES) {
      const rows = await t.all(`SELECT * FROM ${table}`);
      counts[table] = rows.length;
      for (const row of rows) await write({ t: table, r: row });
    }
  });
  await write({ end: true, counts });
  gz.end();
  await once(out, "finish");
  return counts;
}

/** Read any backup file: yields { table, row } and finally returns { header, counts }. */
export async function* readBackup(file) {
  if (file.endsWith(".db")) {
    const copy = new DatabaseSync(file, { readOnly: true });
    try {
      const present = new Set(copy.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map((r) => r.name));
      for (const table of TABLES) {
        if (!present.has(table)) continue;
        for (const row of copy.prepare(`SELECT * FROM ${table}`).all()) yield { table, row: { ...row } };
      }
    } finally {
      copy.close();
    }
    return;
  }
  const lines = createInterface({ input: createReadStream(file).pipe(createGunzip()), crlfDelay: Infinity });
  let header = null;
  for await (const line of lines) {
    if (!line) continue;
    const obj = JSON.parse(line);
    if (!header) {
      if (obj.format !== "agriconnect-backup") throw new Error("Not an AgriConnect backup file");
      header = obj;
    } else if (obj.end) {
      return;
    } else {
      yield { table: obj.t, row: obj.r };
    }
  }
  throw new Error("Backup file is incomplete (no end marker)");
}

/** Open a backup and check it. `expected` = rows per table written (for .jsonl.gz). */
export async function verifyBackup(file, expected = null) {
  const bytes = statSync(file).size;
  try {
    if (file.endsWith(".db")) {
      const copy = new DatabaseSync(file, { readOnly: true });
      try {
        const integrity = Object.values(copy.prepare("PRAGMA integrity_check").get())[0];
        const count = (t) => copy.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get().n;
        return { ok: integrity === "ok", bytes, integrity, farmers: count("farmers"), messages: count("message_log"), staff: count("staff") };
      } finally {
        copy.close();
      }
    }
    const counts = {};
    for await (const { table } of readBackup(file)) counts[table] = (counts[table] ?? 0) + 1;
    const mismatch = expected && TABLES.find((t) => (counts[t] ?? 0) !== (expected[t] ?? 0));
    return {
      ok: !mismatch, bytes, integrity: mismatch ? `row count differs for ${mismatch}` : "ok",
      farmers: counts.farmers ?? 0, messages: counts.message_log ?? 0, staff: counts.staff ?? 0
    };
  } catch (err) {
    return { ok: false, bytes, error: err.message };
  }
}

/**
 * Replace ALL data in `db` with the rows of a backup file (either kind). One transaction:
 * if anything fails, nothing changes. Returns rows imported per table.
 */
export async function importBackup(db, file) {
  return db.tx(async (t) => {
    for (const table of [...TABLES].reverse()) await t.run(`DELETE FROM ${table}`);
    const counts = {};
    for await (const { table, row } of readBackup(file)) {
      const cols = Object.keys(row);
      await t.run(`INSERT INTO ${table} (${cols.join(", ")}) VALUES (${cols.map(() => "?").join(", ")})`, ...cols.map((c) => row[c]));
      counts[table] = (counts[table] ?? 0) + 1;
    }
    if (t.dialect === "postgres") {
      // New rows must get ids after the imported ones.
      for (const table of TABLES) {
        const hasId = await t.get("SELECT 1 AS x FROM information_schema.columns WHERE table_schema = current_schema() AND table_name = ? AND column_name = 'id'", table);
        if (hasId) await t.exec(`SELECT setval(pg_get_serial_sequence('${table}', 'id'), COALESCE((SELECT MAX(id) FROM ${table}), 0) + 1, false)`);
      }
    }
    return counts;
  });
}

export function listBackupFiles(dir) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.startsWith(BACKUP_PREFIX) && (f.endsWith(".db") || f.endsWith(".jsonl.gz")))
    .map((name) => ({ name, bytes: statSync(join(dir, name)).size }))
    .sort((a, b) => b.name.localeCompare(a.name)); // newest first (the name holds the time)
}

export async function lastBackup(db) {
  const r = await db.get("SELECT * FROM backups ORDER BY id DESC LIMIT 1");
  return r ? { ...r, ok: !!r.ok, detail: JSON.parse(r.detail) } : null;
}

// ---------------------------------------------------------------- errors & alerts
let lastAlertAt = 0;
let suppressed = 0;
export const ALERT_EVERY_MS = 5 * 60 * 1000;

/**
 * Record an unexpected error. If ERROR_WEBHOOK_URL is set (e.g. a Slack, Discord or
 * Teams incoming webhook), post a short alert: at most one every 5 minutes. Never throws.
 */
export async function recordError(db, err, context = {}, { webhookUrl = process.env.ERROR_WEBHOOK_URL, fetch = globalThis.fetch, now = new Date() } = {}) {
  const message = String(err?.message ?? err).slice(0, 500);
  console.error(JSON.stringify({ level: "error", time: now.toISOString(), message, ...context }));
  if (webhookUrl) {
    if (now.getTime() - lastAlertAt < ALERT_EVERY_MS) suppressed++;
    else {
      const extra = suppressed ? ` (+${suppressed} more since the last alert)` : "";
      lastAlertAt = now.getTime();
      suppressed = 0;
      const text = `AgriConnect error: ${message}${extra}${context.path ? ` [${context.method} ${context.path}]` : ""}`;
      // "text" works for Slack and Teams, "content" for Discord.
      fetch(webhookUrl, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ text, content: text }) }).catch(() => {});
    }
  }
  try {
    await db.run("INSERT INTO error_log (message, stack, context, created_at) VALUES (?, ?, ?, ?)",
      message, String(err?.stack ?? "").slice(0, 4000), JSON.stringify(context).slice(0, 1000), now.toISOString());
  } catch {
    // never let error logging crash the server (e.g. when the database itself is down)
  }
}
export function resetAlertThrottle() { lastAlertAt = 0; suppressed = 0; }

export async function recentErrors(db, limit = 20) {
  return (await db.all("SELECT id, message, context, created_at FROM error_log ORDER BY id DESC LIMIT ?", limit))
    .map((r) => ({ ...r, context: JSON.parse(r.context || "{}") }));
}

// ---------------------------------------------------------------- status
const STARTED = Date.now();

/** Everything an admin needs to see that the platform is healthy. */
export async function systemStatus(db, { now = new Date(), backupDir, smsProvider, staleBackupHours = 30 } = {}) {
  const backup = await lastBackup(db);
  const weather = await db.get("SELECT MAX(fetched_at) AS t, COUNT(*) AS n FROM weather_forecasts WHERE fetched_at != 'sample'");
  const advice = await db.get("SELECT started_at, result FROM job_runs WHERE job = 'advice' ORDER BY id DESC LIMIT 1");
  const sms = await db.get(`SELECT
      SUM(CASE WHEN status IN ('queued','sending') THEN 1 ELSE 0 END) AS waiting,
      SUM(CASE WHEN status = 'failed' AND created_at >= ? THEN 1 ELSE 0 END) AS failed_24h,
      MIN(CASE WHEN status IN ('queued','sending') THEN created_at END) AS oldest_waiting
    FROM message_log WHERE direction = 'out'`, sqlDaysAgo(1, now));
  const errors24h = (await db.get("SELECT COUNT(*) AS n FROM error_log WHERE created_at >= ?", new Date(now.getTime() - 86400000).toISOString())).n;

  const warnings = [];
  if (!backupDir) warnings.push("Backups are off (set BACKUP_DIR).");
  else if (!backup) warnings.push("No backup has been made yet.");
  else if (!backup.ok) warnings.push("The last backup FAILED its check.");
  else if (now - new Date(backup.created_at) > staleBackupHours * 3600000) warnings.push(`The last backup is older than ${staleBackupHours} hours.`);
  if (smsProvider === "log") warnings.push("SMS provider is 'log': messages are NOT sent to real phones.");
  if ((sms.failed_24h ?? 0) > 0) warnings.push(`${sms.failed_24h} SMS failed in the last 24 hours.`);
  if (sms.oldest_waiting && sqlNow(now) > sqlNow(new Date(Date.parse(sms.oldest_waiting.replace(" ", "T") + "Z") + 15 * 60000))) warnings.push("SMS have been waiting more than 15 minutes: check the SMS provider.");
  if (errors24h) warnings.push(`${errors24h} server error(s) in the last 24 hours.`);
  if (!weather.t) warnings.push("No real weather forecast yet (only sample data or none).");

  return {
    ok: warnings.length === 0,
    warnings,
    database: db.dialect,
    uptime_minutes: Math.round((Date.now() - STARTED) / 60000),
    node: process.version,
    backup: backup ? { at: backup.created_at, ok: backup.ok, bytes: backup.bytes, file: backup.file.split(/[\\/]/).pop() } : null,
    backups_kept: backupDir ? listBackupFiles(backupDir).length : 0,
    sms: { provider: smsProvider, waiting: sms.waiting ?? 0, failed_24h: sms.failed_24h ?? 0 },
    weather: { last_fetch: weather.t, counties: weather.n },
    advice: advice ? { last_run: advice.started_at, ...JSON.parse(advice.result || "{}") } : null,
    errors_24h: errors24h
  };
}
