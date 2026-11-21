// Adds demo farmers and pest reports so the dashboard has something to show.
// Run: npm run seed   (safe to run twice: existing phone numbers are skipped)
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { openDb } from "../src/db.js";
import { loadContent } from "../src/content.js";
import { cleanFarmerInput, createFarmer, getFarmerByPhone } from "../src/farmers.js";
import { createPestReport } from "../src/pestReports.js";
import { createQuestion } from "../src/questions.js";
import { addReporter } from "../src/prices.js";
import { COUNTY_POINTS } from "../src/weather.js";
import { createStaff } from "../src/staff.js";

if (process.env.NODE_ENV === "production") {
  console.error("Refusing to add demo data with NODE_ENV=production. Use npm run create-admin on a real server.");
  process.exit(1);
}

const here = dirname(fileURLToPath(import.meta.url));
const db = await openDb(process.env.DATABASE_URL || process.env.DB_PATH || resolve(here, "../data/agriconnect.db"));
const content = loadContent(process.env.CONTENT_DIR ?? resolve(here, "../../../content"));

// Demo people are fictional. Phone numbers use a test range.
const farmers = [
  { phone: "0770000001", name: "Kollie M.", county: "Bong", district: "Salala", crops: [{ crop: "rice", planting_month: 5 }, { crop: "cassava", planting_month: 4 }] },
  { phone: "0770000002", name: "Fatu K.", county: "Lofa", district: "Voinjama", crops: [{ crop: "rice", planting_month: 6 }] },
  { phone: "0770000003", name: "Musu T.", county: "Nimba", district: "Sanniquellie", crops: [{ crop: "cassava", planting_month: 5 }] },
  { phone: "0770000004", name: "Joseph D.", county: "Margibi", district: "Kakata", crops: [{ crop: "cassava", planting_month: 3 }] },
  { phone: "0770000005", name: "Comfort S.", county: "Grand Bassa", district: "Buchanan", crops: [{ crop: "rice", planting_month: 5 }] },
  { phone: "0770000006", name: "Peter G.", county: "Nimba", district: "Ganta", crops: [{ crop: "rice", planting_month: 6 }] }
];

let added = 0;
for (const f of farmers) {
  if (await getFarmerByPhone(db, f.phone)) continue;
  await createFarmer(db, cleanFarmerInput({ ...f, consent: true, channel: "assisted" }, content));
  added++;
}

// Demo staff accounts for the dashboard (made before the demo reports, so the Nimba hotspot alert reaches Officer Mulbah) (LOCAL DEMO ONLY: these passwords are public in this file).
const DEMO_STAFF = [
  { email: "admin@agriconnect.test", name: "Demo Admin", role: "admin", counties: [], password: "demo-admin-2026" },
  { email: "mulbah@agriconnect.test", name: "Officer Mulbah", role: "officer", counties: ["Bong", "Lofa", "Nimba"], password: "demo-officer-2026", phone: "0886000099" },
  { email: "editor@agriconnect.test", name: "Content Editor", role: "editor", counties: [], password: "demo-editor-2026" },
  { email: "partner@agriconnect.test", name: "Partner Viewer", role: "viewer", counties: [], password: "demo-viewer-2026" },
  { email: "kerkula@agriconnect.test", name: "Lead Farmer Kerkula", role: "lead", counties: ["Bong"], password: "demo-lead-2026" }
];
let staffAdded = 0;
for (const s of DEMO_STAFF) {
  if (await db.get("SELECT 1 AS x FROM staff WHERE email = ?", s.email)) continue;
  await createStaff(db, s);
  staffAdded++;
}
if (staffAdded) {
  console.log("Demo dashboard logins (local demo only):");
  for (const s of DEMO_STAFF) console.log(`  ${s.role.padEnd(8)} ${s.email.padEnd(28)} ${s.password}${s.counties.length ? `   (${s.counties.join(", ")})` : ""}`);
}

// Three fall armyworm reports in Nimba make a hotspot on the dashboard.
const reports = [
  { phone: "0770000006", crop: "rice", symptoms: ["holes", "caterpillar"], channel: "ussd" },
  { phone: "0880000101", county: "Nimba", crop: "maize", symptoms: ["holes", "caterpillar"], channel: "ussd" },
  { phone: "0880000102", county: "Nimba", crop: "rice", symptoms: ["caterpillar", "holes"], channel: "ussd" },
  { phone: "0770000003", crop: "cassava", symptoms: ["yellow", "twisted"], channel: "ussd" },
  { phone: "0770000002", crop: "rice", symptoms: ["spots", "brown"], channel: "app" }
];

// Only add the demo reports and questions the first time, so running seed twice doesn't duplicate them.
if (added) {
  for (const r of reports) await createPestReport(db, content, r);
  await createQuestion(db, { farmer: await getFarmerByPhone(db, "0770000001"), kind: "text", channel: "sms", body: "My pepper leaves are curling and turning yellow. What can I do?" });
  await createQuestion(db, { farmer: await getFarmerByPhone(db, "0770000002"), kind: "callback", channel: "ussd" });
  await createQuestion(db, { farmer: await getFarmerByPhone(db, "0770000004"), kind: "text", channel: "sms", body: "When is the best time to harvest cassava for gari?" });
}

// Market reporters and two weeks of SAMPLE prices (LRD) for every market.
const BASE = { "rice-local": 45, "rice-imported": 4100, cassava: 500, gari: 30, pepper: 75, "palm-oil": 950, cocoa: 1250, plantain: 550 };
const MARKET_FACTOR = { redlight: 1.15, gbarnga: 1, ganta: 1.02, voinjama: 0.9, buchanan: 1.08, kakata: 1.05 };
const ctx = { db, content, now: () => new Date() };
let prices = 0;
if (!(await db.get("SELECT 1 AS x FROM prices LIMIT 1"))) {
  for (const [i, m] of content.markets.entries()) await addReporter(ctx, { phone: `08860000${String(i + 1).padStart(2, "0")}`, name: `${m.name} reporter`, market: m.id });
  const insert = (...args) => db.run("INSERT INTO prices (market, item, price_lrd, reporter, status, reported_at) VALUES (?, ?, ?, 'seed', 'ok', ?)", ...args);
  for (const m of content.markets) for (const it of content.items) {
    if (it.id === "cocoa" && !["ganta", "voinjama"].includes(m.id)) continue; // cocoa is traded up-country
    for (const daysAgo of [12, 9, 5, 1]) {
      const trend = daysAgo > 7 ? 0.94 : 1; // prices a bit lower last week
      const price = Math.round(BASE[it.id] * MARKET_FACTOR[m.id] * trend * (0.97 + ((daysAgo * 7 + it.id.length) % 7) / 100));
      await insert(m.id, it.id, price, new Date(Date.now() - daysAgo * 86400000).toISOString());
      prices++;
    }
  }
}

// A SAMPLE forecast so the demo works without internet. It is shown as "sample" and is
// replaced by the real Open-Meteo forecast as soon as the server can reach it.
if (!(await db.get("SELECT 1 AS x FROM weather_forecasts LIMIT 1"))) {
  const day = (n) => new Date(Date.now() + n * 86400000).toISOString().slice(0, 10);
  for (const [i, county] of Object.keys(COUNTY_POINTS).entries()) {
    const rain = i % 3 === 0 ? [80, 85, 40, 20, 15] : [35, 20, 25, 45, 30];
    const days = rain.map((r, n) => ({ date: day(n), rain_prob: r, rain_mm: r >= 70 ? 22 : 2, t_max: 30 + (n % 3), t_min: 23, code: r >= 70 ? 63 : 2 }));
    await db.run("INSERT INTO weather_forecasts (county, days, fetched_at) VALUES (?, ?, 'sample')", county, JSON.stringify(days));
  }
}

console.log(`Seeded ${added} new farmers${added ? `, ${reports.length} pest reports and 3 questions` : " (demo data already present)"}${prices ? `, ${prices} sample prices` : ""}.`);
await db.close();
