// Load test (Sprint 6): can AgriConnect handle a big pilot?
//
//   npm run load-test                       # 10,000 farmers in a throw-away SQLite file
//   npm run load-test -- --farmers 20000
//   DATABASE_URL=postgres://… npm run load-test   # in an EMPTY PostgreSQL database (it is filled with test data)
//
// It measures: registering farmers, one advisory to all of them (10,000 SMS), sending the queue
// through a stand-in SMS provider that takes --latency ms per message (like a real one),
// USSD screens, the daily advice job, and the officer dashboard's heaviest pages.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { openDb, sqlNow } from "../src/db.js";
import { loadContent } from "../src/content.js";
import { previewBroadcast, sendBroadcast, getBroadcast } from "../src/broadcasts.js";
import { deliverQueued } from "../src/messaging.js";
import { handleUssd } from "../src/ussd.js";
import { runAdviceJob } from "../src/scheduler.js";
import { listFarmers, exportFarmersCsv } from "../src/farmers.js";
import { listHotspots } from "../src/hotspots.js";
import { SMS_CONCURRENCY } from "../src/messaging.js";

const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? Number(process.argv[i + 1]) : fallback;
};
const FARMERS = arg("farmers", 10000);
const LATENCY = arg("latency", 50); // ms per SMS at the provider
const USSD = arg("ussd", 500);

const here = dirname(fileURLToPath(import.meta.url));
const content = loadContent(process.env.CONTENT_DIR ?? resolve(here, "../../../content"));
const tmp = process.env.DATABASE_URL ? null : mkdtempSync(join(tmpdir(), "agri-load-"));
const db = await openDb(process.env.DATABASE_URL || join(tmp, "load.db"));
if (process.env.DATABASE_URL && (await db.get("SELECT COUNT(*) AS n FROM farmers")).n > 0) {
  console.error("This database already has farmers. Use an EMPTY database for the load test.");
  process.exit(1);
}
const ctx = { db, content, now: () => new Date() };
const COUNTIES = ["Bong", "Nimba", "Lofa", "Margibi", "Grand Bassa", "Montserrado"];
const results = [];
const time = async (label, fn, unit) => {
  const t = performance.now();
  const out = await fn();
  const ms = performance.now() - t;
  results.push({ step: label, seconds: +(ms / 1000).toFixed(2), ...(unit ? { rate: `${Math.round(unit / (ms / 1000)).toLocaleString("en-US")}/s` } : {}) });
  console.log(`  ${label}: ${(ms / 1000).toFixed(2)} s${unit ? ` (${Math.round(unit / (ms / 1000)).toLocaleString("en-US")}/s)` : ""}`);
  return out;
};

console.log(`Load test: ${FARMERS.toLocaleString("en-US")} farmers on ${db.dialect}, provider ${LATENCY} ms per SMS, ${SMS_CONCURRENCY} sent at a time\n`);

await time(`register ${FARMERS.toLocaleString("en-US")} farmers`, () => db.tx(async (t) => {
  for (let i = 0; i < FARMERS; i++) {
    const { id } = await t.get("INSERT INTO farmers (phone, name, county, district, language, channel, consent_at) VALUES (?, ?, ?, ?, 'en', 'ussd', ?) RETURNING id",
      `+2317${String(70000000 + i)}`, `Farmer ${i}`, COUNTIES[i % COUNTIES.length], `District ${i % 40}`, sqlNow());
    await t.run("INSERT INTO farmer_crops (farmer_id, crop, planting_month) VALUES (?, ?, ?)", id, i % 3 ? "rice" : "cassava", 1 + (i % 12));
  }
}), FARMERS);

const reach = await time("preview an advisory to everyone", () => previewBroadcast(db, content, { counties: [], crops: [] }));
console.log(`    reach: ${reach.reach.toLocaleString("en-US")} farmers`);
const b = await time(`queue the advisory (${reach.reach.toLocaleString("en-US")} SMS)`, () =>
  sendBroadcast(db, content, { counties: [], crops: [], message: "Fall armyworm in 6 counties. Check your fields this week. Dial *347# option 4 to report." }), reach.reach);

// The background sender, as in the server: one batch after another until the queue is empty.
const provider = { name: "stand-in", send: async () => { await new Promise((r) => setTimeout(r, LATENCY)); return { ok: true, id: `p${Math.random()}` }; } };
await time(`send all ${reach.reach.toLocaleString("en-US")} SMS through the provider`, async () => {
  for (;;) {
    const r = await deliverQueued(db, provider, { now: new Date() });
    if (!r.sent && !r.retrying && !r.failed) break;
  }
}, reach.reach);
const done = await getBroadcast(db, b.id);
console.log(`    sent: ${done.sms.sent.toLocaleString("en-US")}, still queued: ${done.sms.queued}, failed: ${done.sms.failed}`);

await time(`${USSD} USSD screens (registered farmers, main menu + advice)`, async () => {
  for (let i = 0; i < USSD; i++) await handleUssd(ctx, { phoneNumber: `+2317${String(70000000 + i)}`, text: i % 2 ? "" : "1" });
}, USSD);

await time("daily advice job for every farmer", () => runAdviceJob(ctx, { dryRun: true }), FARMERS);
await time("officer: search farmers", () => listFarmers(db, { q: "farmer 77", counties: ["Bong", "Nimba"] }));
await time("officer: CSV of one county", () => exportFarmersCsv(db, { counties: ["Bong"] }));
await time("hotspots", () => listHotspots(db, content));

console.log("\nSummary");
console.table(results);
await db.close();
if (tmp) rmSync(tmp, { recursive: true, force: true });
