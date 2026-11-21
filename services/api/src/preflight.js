// Pilot readiness check (Sprint 6): everything that must be true before real farmers use the
// system, in one list. Used by `npm run preflight` on the server and by the admin's
// "Pilot readiness" card. Each check: { area, name, ok, detail, blocking }.
// blocking = the pilot must not start until it passes; the others are strong advice.
import { sqlDaysAgo, sqlNow } from "./db.js";
import { listContent } from "./contentEditor.js";
import { lastBackup, lastRestoreDrill } from "./ops.js";
import { signupFunnel } from "./fieldTest.js";

export async function pilotReadiness(db, content, { env = process.env, now = new Date(), pilotCounties } = {}) {
  const counties = pilotCounties ?? String(env.PILOT_COUNTIES ?? "Bong,Nimba").split(",").map((c) => c.trim()).filter(Boolean);
  const checks = [];
  const add = (area, name, ok, detail, blocking = true) => checks.push({ area, name, ok: !!ok, detail, blocking });

  // ---- Server settings
  add("Server", "Runs in production mode", env.NODE_ENV === "production", "NODE_ENV=production");
  add("Server", "Demo mode is off", env.DEMO_MODE !== "1", env.DEMO_MODE === "1" ? "DEMO_MODE=1 shows sign-in codes on screen: turn it off before real farmers join" : "off");
  add("Server", "2-step login is required for all staff", env.REQUIRE_2FA === "1", "REQUIRE_2FA=1");
  const provider = env.SMS_PROVIDER ?? "log";
  add("Server", "A real SMS provider is set", provider !== "log", provider === "log" ? "SMS_PROVIDER is 'log': nothing reaches phones" : `SMS_PROVIDER=${provider}`);
  add("Server", "Telco webhooks need the secret", !!env.WEBHOOK_SECRET, "WEBHOOK_SECRET");
  if (env.HOSTING === "vercel") add("Server", "Database backups are on", true, "on Vercel the database host (Neon) keeps the backups: check its restore window", false);
  else add("Server", "Daily backups are on", !!env.BACKUP_DIR, env.BACKUP_DIR ? `BACKUP_DIR=${env.BACKUP_DIR}` : "BACKUP_DIR is not set");
  add("Server", "PostgreSQL database", db.dialect === "postgres", db.dialect === "postgres" ? "DATABASE_URL" : "SQLite: fine for a laptop, use PostgreSQL on the server", false);

  // ---- Staff
  const staff = (await db.all("SELECT email, name, role, counties, phone, totp_enabled, active FROM staff WHERE active = 1"))
    .map((s) => ({ ...s, counties: JSON.parse(s.counties) }));
  const demo = staff.filter((s) => s.email.endsWith("@agriconnect.test"));
  add("Staff", "No demo accounts are switched on", !demo.length, demo.length ? `switch off: ${demo.map((s) => s.email).join(", ")}` : "none");
  const admins = staff.filter((s) => s.role === "admin");
  add("Staff", "At least two admins (one can be away)", admins.length >= 2, `${admins.length} admin(s)`, false);
  const no2fa = staff.filter((s) => ["admin", "officer", "agronomist"].includes(s.role) && !s.totp_enabled);
  add("Staff", "Admins, officers and agronomists use 2-step login", !no2fa.length, no2fa.length ? `not yet: ${no2fa.map((s) => s.name).join(", ")}` : "all");
  for (const county of counties) {
    const officers = staff.filter((s) => s.role === "officer" && s.counties.includes(county));
    add("Staff", `${county}: an officer covers the county`, officers.length > 0, officers.length ? officers.map((o) => o.name).join(", ") : "nobody: questions and reports would go unanswered");
    add("Staff", `${county}: an officer gets hotspot alerts by SMS`, officers.some((o) => o.phone), officers.some((o) => o.phone) ? "yes" : "no officer has an alert phone", false);
  }
  add("Staff", "An agronomist account exists", staff.some((s) => s.role === "agronomist"), "approves advice texts");

  // ---- Content
  const review = (await listContent(db, content)).progress;
  add("Content", "Every English advice text is approved by an agronomist", review.all_en_approved, `${review.en.approved} of ${review.en.total} approved`);
  add("Content", "Translations approved (Kpelle, Bassa, Kissi)", review.translations.approved > 0, `${review.translations.approved} approved: farmers who chose a local language get English until then`, false);
  const reporters = (await db.get("SELECT COUNT(*) AS n FROM market_reporters WHERE active = 1")).n;
  add("Content", "Market price reporters are registered", Number(reporters) > 0, `${reporters} reporter(s)`, false);
  const weather = await db.get("SELECT MAX(fetched_at) AS t FROM weather_forecasts WHERE fetched_at != 'sample'");
  add("Content", "A real weather forecast has arrived", !!weather.t, weather.t ? `last ${String(weather.t).slice(0, 16)}` : "only sample data: check internet access to Open-Meteo", false);

  // ---- Backups
  const b = await lastBackup(db);
  const fresh = b?.ok && sqlNow(now) <= sqlNow(new Date(Date.parse(String(b.created_at).replace(" ", "T").replace(/Z?$/, "Z")) + 30 * 3600000));
  add("Backups", "A checked backup from the last 30 hours", fresh, b ? `${b.ok ? "OK" : "FAILED"} at ${String(b.created_at).slice(0, 16)}` : "no backup yet");
  const d = await lastRestoreDrill(db);
  const drillFresh = d?.ok && sqlNow(now) <= sqlNow(new Date(Date.parse(String(d.at).replace(" ", "T") + "Z") + 30 * 86400000));
  add("Backups", "A restore drill passed in the last 30 days", drillFresh, d ? `${d.ok ? "passed" : "FAILED"} ${String(d.at).slice(0, 10)}` : "never: npm run restore-drill");

  // ---- Running health (these become meaningful once the field test has started)
  const sms = await db.get(`SELECT COUNT(*) AS total, SUM(CASE WHEN status = 'delivered' THEN 1 ELSE 0 END) AS delivered, SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) AS failed
    FROM message_log WHERE direction = 'out' AND created_at >= ? AND status IN ('sent', 'delivered', 'failed')`, sqlDaysAgo(7, now));
  const settled = Number(sms.delivered ?? 0) + Number(sms.failed ?? 0);
  add("Field test", "SMS delivered: 95% or more (last 7 days)", settled < 20 || Number(sms.delivered) / settled >= 0.95,
    settled < 20 ? "not enough delivery reports yet" : `${Math.round((100 * Number(sms.delivered)) / settled)}% of ${settled}`, false);
  const funnel = await signupFunnel(db, { now });
  const finished = funnel.registered + funnel.cancelled + funnel.abandoned;
  add("Field test", "80% or more finish signing up on *347#", finished < 30 || funnel.meets_target,
    finished < 30 ? `${finished} tries so far (judged from 30)` : `${Math.round(funnel.completion_rate * 100)}% of ${finished}`, false);
  const errors = (await db.get("SELECT COUNT(*) AS n FROM error_log WHERE created_at >= ?", new Date(now.getTime() - 86400000).toISOString())).n;
  add("Field test", "No server errors in the last 24 hours", Number(errors) === 0, `${errors} error(s)`, false);

  const blocking = checks.filter((c) => c.blocking && !c.ok);
  return { ready: blocking.length === 0, blocking: blocking.length, warnings: checks.filter((c) => !c.blocking && !c.ok).length, counties, checks };
}
