// Pilot readiness check: run it on the server before real farmers use AgriConnect.
//   docker compose exec api npm run preflight        (or: npm run preflight)
// Exits with 1 while anything marked ✗ BLOCKING remains. PILOT_COUNTIES=Bong,Nimba by default.
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { openDb } from "../src/db.js";
import { loadContent } from "../src/content.js";
import { applyApprovedTexts } from "../src/contentEditor.js";
import { pilotReadiness } from "../src/preflight.js";

const here = dirname(fileURLToPath(import.meta.url));
const db = await openDb(process.env.DATABASE_URL || process.env.DB_PATH || resolve(here, "../data/agriconnect.db"));
const content = loadContent(process.env.CONTENT_DIR ?? resolve(here, "../../../content"));
await applyApprovedTexts(db, content);
const r = await pilotReadiness(db, content);
await db.close();

console.log(`AgriConnect pilot readiness (${r.counties.join(", ")})\n`);
let area = "";
for (const c of r.checks) {
  if (c.area !== area) { area = c.area; console.log(`${area}`); }
  const mark = c.ok ? "  ✓" : c.blocking ? "  ✗ BLOCKING" : "  ! advice  ";
  console.log(`${mark} ${c.name}: ${c.detail}`);
}
console.log(r.ready
  ? `\nREADY for the pilot${r.warnings ? ` (${r.warnings} piece(s) of advice above)` : ""}.`
  : `\nNOT READY: ${r.blocking} blocking item(s) above.`);
process.exit(r.ready ? 0 : 1);
