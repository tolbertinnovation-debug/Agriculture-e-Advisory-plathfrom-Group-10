// Operations: backups, error log + alerts, and a system status report for admins.
import { DatabaseSync } from "node:sqlite";
import { mkdirSync, readdirSync, statSync, unlinkSync, existsSync } from "node:fs";
import { join } from "node:path";

// ---------------------------------------------------------------- backups
export const BACKUP_PREFIX = "agriconnect-";

/**
 * Make a consistent copy of the live database (SQLite "VACUUM INTO" is safe while the
 * server is running), then CHECK the copy: integrity check + the main tables can be read.
 * Old backups beyond `keep` are deleted. Returns { file, bytes, ok, farmers, removed }.
 */
export function backupDatabase(db, dir, { now = new Date(), keep = 14 } = {}) {
  mkdirSync(dir, { recursive: true });
  const stamp = now.toISOString().replace(/[-:]/g, "").replace("T", "-").slice(0, 15); // 20261120-170600
  const file = join(dir, `${BACKUP_PREFIX}${stamp}.db`);
  if (existsSync(file)) unlinkSync(file);
  db.exec(`VACUUM INTO '${file.replace(/'/g, "''")}'`);

  const check = verifyBackup(file);
  db.prepare("INSERT INTO backups (file, bytes, ok, detail, created_at) VALUES (?, ?, ?, ?, ?)")
    .run(file, check.bytes, check.ok ? 1 : 0, JSON.stringify(check), now.toISOString());

  // Keep the newest `keep` good backups.
  const all = listBackupFiles(dir);
  const removed = [];
  for (const old of all.slice(keep)) { unlinkSync(join(dir, old.name)); removed.push(old.name); }
  return { file, ...check, removed };
}

/** Open a backup read-only and check it. */
export function verifyBackup(file) {
  const bytes = statSync(file).size;
  let copy;
  try {
    copy = new DatabaseSync(file, { readOnly: true });
    const integrity = copy.prepare("PRAGMA integrity_check").get();
    const ok = Object.values(integrity)[0] === "ok";
    const count = (t) => copy.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get().n;
    return { ok, bytes, integrity: Object.values(integrity)[0], farmers: count("farmers"), messages: count("message_log"), staff: count("staff") };
  } catch (err) {
    return { ok: false, bytes, error: err.message };
  } finally {
    copy?.close();
  }
}

export function listBackupFiles(dir) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.startsWith(BACKUP_PREFIX) && f.endsWith(".db"))
    .map((name) => ({ name, bytes: statSync(join(dir, name)).size }))
    .sort((a, b) => b.name.localeCompare(a.name)); // newest first (the name holds the time)
}

export function lastBackup(db) {
  const r = db.prepare("SELECT * FROM backups ORDER BY id DESC LIMIT 1").get();
  return r ? { ...r, ok: !!r.ok, detail: JSON.parse(r.detail) } : null;
}

// ---------------------------------------------------------------- errors & alerts
let lastAlertAt = 0;
let suppressed = 0;
export const ALERT_EVERY_MS = 5 * 60 * 1000;

/**
 * Record an unexpected error. If ERROR_WEBHOOK_URL is set (e.g. a Slack, Discord or
 * Teams incoming webhook), post a short alert: at most one every 5 minutes.
 */
export function recordError(db, err, context = {}, { webhookUrl = process.env.ERROR_WEBHOOK_URL, fetch = globalThis.fetch, now = new Date() } = {}) {
  const message = String(err?.message ?? err).slice(0, 500);
  try {
    db.prepare("INSERT INTO error_log (message, stack, context, created_at) VALUES (?, ?, ?, ?)")
      .run(message, String(err?.stack ?? "").slice(0, 4000), JSON.stringify(context).slice(0, 1000), now.toISOString());
  } catch {
    // never let error logging crash the server
  }
  console.error(JSON.stringify({ level: "error", time: now.toISOString(), message, ...context }));
  if (!webhookUrl) return;
  if (now.getTime() - lastAlertAt < ALERT_EVERY_MS) { suppressed++; return; }
  const extra = suppressed ? ` (+${suppressed} more since the last alert)` : "";
  lastAlertAt = now.getTime();
  suppressed = 0;
  const text = `AgriConnect error: ${message}${extra}${context.path ? ` [${context.method} ${context.path}]` : ""}`;
  // "text" works for Slack and Teams, "content" for Discord.
  fetch(webhookUrl, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ text, content: text }) }).catch(() => {});
}
export function resetAlertThrottle() { lastAlertAt = 0; suppressed = 0; }

export function recentErrors(db, limit = 20) {
  return db.prepare("SELECT id, message, context, created_at FROM error_log ORDER BY id DESC LIMIT ?").all(limit)
    .map((r) => ({ ...r, context: JSON.parse(r.context || "{}") }));
}

// ---------------------------------------------------------------- status
const STARTED = Date.now();

/** Everything an admin needs to see that the platform is healthy. */
export function systemStatus(db, { now = new Date(), backupDir, smsProvider, staleBackupHours = 30 } = {}) {
  const one = (sql, ...a) => db.prepare(sql).get(...a);
  const backup = lastBackup(db);
  const weather = one("SELECT MAX(fetched_at) AS t, COUNT(*) AS n FROM weather_forecasts WHERE fetched_at != 'sample'");
  const advice = one("SELECT started_at, result FROM job_runs WHERE job = 'advice' ORDER BY id DESC LIMIT 1");
  const sms = one(`SELECT
      SUM(CASE WHEN status IN ('queued','sending') THEN 1 ELSE 0 END) AS waiting,
      SUM(CASE WHEN status = 'failed' AND created_at >= datetime('now','-1 day') THEN 1 ELSE 0 END) AS failed_24h,
      MIN(CASE WHEN status IN ('queued','sending') THEN created_at END) AS oldest_waiting
    FROM message_log WHERE direction = 'out'`);
  const errors24h = one("SELECT COUNT(*) AS n FROM error_log WHERE created_at >= ?", new Date(now.getTime() - 86400000).toISOString()).n;

  const warnings = [];
  if (!backupDir) warnings.push("Backups are off (set BACKUP_DIR).");
  else if (!backup) warnings.push("No backup has been made yet.");
  else if (!backup.ok) warnings.push("The last backup FAILED its check.");
  else if (now - new Date(backup.created_at) > staleBackupHours * 3600000) warnings.push(`The last backup is older than ${staleBackupHours} hours.`);
  if (smsProvider === "log") warnings.push("SMS provider is 'log': messages are NOT sent to real phones.");
  if ((sms.failed_24h ?? 0) > 0) warnings.push(`${sms.failed_24h} SMS failed in the last 24 hours.`);
  if (sms.oldest_waiting && now - new Date(sms.oldest_waiting.replace(" ", "T") + "Z") > 15 * 60000) warnings.push("SMS have been waiting more than 15 minutes: check the SMS provider.");
  if (errors24h) warnings.push(`${errors24h} server error(s) in the last 24 hours.`);
  if (!weather.t) warnings.push("No real weather forecast yet (only sample data or none).");

  return {
    ok: warnings.length === 0,
    warnings,
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
