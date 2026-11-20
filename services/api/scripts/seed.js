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

const here = dirname(fileURLToPath(import.meta.url));
const db = openDb(process.env.DB_PATH ?? resolve(here, "../data/agriconnect.db"));
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
  if (getFarmerByPhone(db, f.phone)) continue;
  createFarmer(db, cleanFarmerInput({ ...f, consent: true, channel: "assisted" }, content));
  added++;
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
  for (const r of reports) createPestReport(db, content, r);
  createQuestion(db, { farmer: getFarmerByPhone(db, "0770000001"), kind: "text", channel: "sms", body: "My pepper leaves are curling and turning yellow. What can I do?" });
  createQuestion(db, { farmer: getFarmerByPhone(db, "0770000002"), kind: "callback", channel: "ussd" });
  createQuestion(db, { farmer: getFarmerByPhone(db, "0770000004"), kind: "text", channel: "sms", body: "When is the best time to harvest cassava for gari?" });
}

// Market reporters and two weeks of SAMPLE prices (LRD) for every market.
const BASE = { "rice-local": 45, "rice-imported": 4100, cassava: 500, gari: 30, pepper: 75, "palm-oil": 950, cocoa: 1250, plantain: 550 };
const MARKET_FACTOR = { redlight: 1.15, gbarnga: 1, ganta: 1.02, voinjama: 0.9, buchanan: 1.08, kakata: 1.05 };
const ctx = { db, content, now: () => new Date() };
let prices = 0;
if (!db.prepare("SELECT 1 FROM prices LIMIT 1").get()) {
  content.markets.forEach((m, i) => addReporter(ctx, { phone: `08860000${String(i + 1).padStart(2, "0")}`, name: `${m.name} reporter`, market: m.id }));
  const insert = db.prepare("INSERT INTO prices (market, item, price_lrd, reporter, status, reported_at) VALUES (?, ?, ?, 'seed', 'ok', ?)");
  for (const m of content.markets) for (const it of content.items) {
    if (it.id === "cocoa" && !["ganta", "voinjama"].includes(m.id)) continue; // cocoa is traded up-country
    for (const daysAgo of [12, 9, 5, 1]) {
      const trend = daysAgo > 7 ? 0.94 : 1; // prices a bit lower last week
      const price = Math.round(BASE[it.id] * MARKET_FACTOR[m.id] * trend * (0.97 + ((daysAgo * 7 + it.id.length) % 7) / 100));
      insert.run(m.id, it.id, price, new Date(Date.now() - daysAgo * 86400000).toISOString());
      prices++;
    }
  }
}

// A SAMPLE forecast so the demo works without internet. It is shown as "sample" and is
// replaced by the real Open-Meteo forecast as soon as the server can reach it.
if (!db.prepare("SELECT 1 FROM weather_forecasts LIMIT 1").get()) {
  const day = (n) => new Date(Date.now() + n * 86400000).toISOString().slice(0, 10);
  Object.keys(COUNTY_POINTS).forEach((county, i) => {
    const rain = i % 3 === 0 ? [80, 85, 40, 20, 15] : [35, 20, 25, 45, 30];
    const days = rain.map((r, n) => ({ date: day(n), rain_prob: r, rain_mm: r >= 70 ? 22 : 2, t_max: 30 + (n % 3), t_min: 23, code: r >= 70 ? 63 : 2 }));
    db.prepare("INSERT INTO weather_forecasts (county, days, fetched_at) VALUES (?, ?, 'sample')").run(county, JSON.stringify(days));
  });
}

console.log(`Seeded ${added} new farmers${added ? `, ${reports.length} pest reports and 3 questions` : " (demo data already present)"}${prices ? `, ${prices} sample prices` : ""}.`);
