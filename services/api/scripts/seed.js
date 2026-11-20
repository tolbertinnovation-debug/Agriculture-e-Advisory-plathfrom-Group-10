// Adds demo farmers and pest reports so the dashboard has something to show.
// Run: npm run seed   (safe to run twice: existing phone numbers are skipped)
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { openDb } from "../src/db.js";
import { loadContent } from "../src/content.js";
import { cleanFarmerInput, createFarmer, getFarmerByPhone } from "../src/farmers.js";
import { createPestReport } from "../src/pestReports.js";

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

const reports = [
  { phone: "0770000006", crop: "rice", symptoms: ["holes", "caterpillar"], channel: "ussd" },
  { phone: "0770000003", crop: "cassava", symptoms: ["yellow", "twisted"], channel: "ussd" },
  { phone: "0770000002", crop: "rice", symptoms: ["spots", "brown"], channel: "app" }
];
// Only add the demo reports the first time, so running seed twice doesn't duplicate them.
if (added) for (const r of reports) createPestReport(db, content, r);

console.log(`Seeded ${added} new farmers${added ? ` and ${reports.length} pest reports` : " (demo data already present)"}.`);
