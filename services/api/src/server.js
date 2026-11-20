// Starts the API: opens the database, loads and checks content, starts the background
// workers (SMS sender, daily advice, weather, backups) and listens on PORT.
// Settings come from environment variables: see deploy/.env.example and docs/deploy.md.
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { openDb } from "./db.js";
import { loadContent, validateContent } from "./content.js";
import { createApp } from "./app.js";
import { providerFromEnv } from "./providers/index.js";
import { startWorkers } from "./scheduler.js";
import { recordError } from "./ops.js";

const here = dirname(fileURLToPath(import.meta.url));
const env = process.env;
const PORT = Number(env.PORT ?? 3000);
const DB_PATH = env.DB_PATH ?? resolve(here, "../data/agriconnect.db");
const CONTENT_DIR = env.CONTENT_DIR ?? resolve(here, "../../../content");
const PRODUCTION = env.NODE_ENV === "production";

const content = loadContent(CONTENT_DIR);
const problems = validateContent(content);
if (problems.length) {
  console.error("Content has problems. Fix the files in /content:\n - " + problems.join("\n - "));
  process.exit(1);
}

let provider;
try {
  provider = providerFromEnv();
} catch (err) {
  console.error(`SMS settings problem: ${err.message}`);
  process.exit(1);
}

// On a real server, refuse to start with settings that would leave farmers' data open.
if (PRODUCTION) {
  const fatal = [];
  if (env.STAFF_AUTH === "off") fatal.push("STAFF_AUTH=off is not allowed in production");
  if (provider.name !== "log" && !env.WEBHOOK_SECRET) fatal.push("WEBHOOK_SECRET must be set when a real SMS provider is used");
  if (fatal.length) {
    console.error("Refusing to start:\n - " + fatal.join("\n - "));
    process.exit(1);
  }
}

const ADVICE_HOUR = Number(env.ADVICE_HOUR ?? 7);
const BACKUP_DIR = env.BACKUP_DIR || undefined;
const db = openDb(DB_PATH);
const app = createApp({ db, content, adviceHour: ADVICE_HOUR, providerName: provider.name, backupDir: BACKUP_DIR });

// Never die silently: log unexpected errors (and alert, if ERROR_WEBHOOK_URL is set).
process.on("unhandledRejection", (err) => recordError(db, err, { source: "unhandledRejection" }));
process.on("uncaughtException", (err) => {
  recordError(db, err, { source: "uncaughtException" });
  setTimeout(() => process.exit(1), 500); // let Docker restart a clean process
});

const stopWorkers = startWorkers({ db, content, now: () => new Date() }, provider, {
  adviceHour: ADVICE_HOUR,
  scheduler: env.SCHEDULER !== "off",
  weather: env.WEATHER !== "off",
  weatherUrl: env.WEATHER_URL,
  backupDir: BACKUP_DIR,
  backupHour: Number(env.BACKUP_HOUR ?? 2),
  backupKeep: Number(env.BACKUP_KEEP ?? 14)
});

const server = app.listen(PORT, () => {
  console.log(`AgriConnect API running on http://localhost:${PORT}${PRODUCTION ? " (production)" : ""}`);
  console.log(`Database: ${DB_PATH}`);
  console.log(`Content: ${content.crops.size} crops, ${content.pests.length} pests`);
  console.log(`SMS provider: ${provider.name}${provider.name === "log" ? " (development: messages are recorded, not sent to phones)" : ""}`);
  console.log(`Weather: ${env.WEATHER === "off" ? "OFF" : `Open-Meteo forecasts every 3 hours${env.WEATHER_URL ? ` (from ${env.WEATHER_URL})` : ""}`}`);
  console.log(`Daily crop advice: ${env.SCHEDULER === "off" ? "OFF" : `every day at ${String(ADVICE_HOUR).padStart(2, "0")}:00 Liberia time`}`);
  console.log(`Backups: ${BACKUP_DIR ? `daily at ${String(env.BACKUP_HOUR ?? 2).padStart(2, "0")}:00 to ${BACKUP_DIR}, keeping ${env.BACKUP_KEEP ?? 14}` : "OFF (set BACKUP_DIR)"}`);
  if (!env.WEBHOOK_SECRET && provider.name !== "log") console.warn("WEBHOOK_SECRET is not set: anyone could call /ussd and /sms/inbound. Set it before going live.");
  if (env.STAFF_AUTH === "off") console.warn("STAFF_AUTH=off: the officer dashboard needs NO login. Only for a quick local demo, never on a shared server.");
  else if (!db.prepare("SELECT 1 FROM staff WHERE role = 'admin' AND active = 1").get())
    console.warn("No admin account yet. Create one: npm run create-admin -- you@example.org \"Your Name\"  (or npm run seed for local demo accounts)");
  if (env.REQUIRE_2FA !== "1") console.warn("REQUIRE_2FA is not set: staff may log in with a password only. Set REQUIRE_2FA=1 on a real server.");
  if (PRODUCTION && !BACKUP_DIR) console.warn("BACKUP_DIR is not set: NO backups are being made.");
});

// Clean shutdown (Docker sends SIGTERM): stop taking requests, stop the workers, close the database.
function shutdown(signal) {
  console.log(`${signal}: shutting down…`);
  stopWorkers();
  server.close(() => {
    try { db.close(); } catch {}
    console.log("Stopped cleanly.");
    process.exit(0);
  });
  setTimeout(() => process.exit(0), 10000).unref();
}
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
