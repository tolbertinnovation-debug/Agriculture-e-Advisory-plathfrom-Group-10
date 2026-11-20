// Starts the API: opens the database, loads and checks content, listens on PORT.
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { openDb } from "./db.js";
import { loadContent, validateContent } from "./content.js";
import { createApp } from "./app.js";
import { providerFromEnv } from "./providers/index.js";
import { startWorkers } from "./scheduler.js";

const here = dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT ?? 3000);
const DB_PATH = process.env.DB_PATH ?? resolve(here, "../data/agriconnect.db");
const CONTENT_DIR = process.env.CONTENT_DIR ?? resolve(here, "../../../content");

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

const ADVICE_HOUR = Number(process.env.ADVICE_HOUR ?? 7);
const db = openDb(DB_PATH);
const app = createApp({ db, content, adviceHour: ADVICE_HOUR, providerName: provider.name });
startWorkers({ db, content, now: () => new Date() }, provider, {
  adviceHour: ADVICE_HOUR,
  scheduler: process.env.SCHEDULER !== "off"
});
app.listen(PORT, () => {
  console.log(`AgriConnect API running on http://localhost:${PORT}`);
  console.log(`Database: ${DB_PATH}`);
  console.log(`Content: ${content.crops.size} crops, ${content.pests.length} pests`);
  console.log(`SMS provider: ${provider.name}${provider.name === "log" ? " (development: messages are recorded, not sent to phones)" : ""}`);
  console.log(`Daily crop advice: ${process.env.SCHEDULER === "off" ? "OFF" : `every day at ${String(ADVICE_HOUR).padStart(2, "0")}:00 Liberia time`}`);
  if (!process.env.WEBHOOK_SECRET && provider.name !== "log") console.warn("WEBHOOK_SECRET is not set: anyone could call /ussd and /sms/inbound. Set it before going live.");
  if (!process.env.OFFICER_TOKEN) console.warn("OFFICER_TOKEN is not set: officer pages are open. Fine on your laptop, never on a shared server.");
});
