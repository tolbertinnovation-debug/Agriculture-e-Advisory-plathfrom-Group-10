// Move all data from a SQLite database (laptop / hackathon server) into PostgreSQL.
// Usage:
//   DATABASE_URL=postgres://user:pw@host:5432/agriconnect npm run sqlite-to-postgres -- data/agriconnect.db --yes
// The PostgreSQL database gets the AgriConnect tables automatically. It must be EMPTY
// (no farmers or staff yet) unless you add --replace. One transaction: all or nothing.
import { existsSync } from "node:fs";
import { openDb, TABLES } from "../src/db.js";
import { verifyBackup, importBackup } from "../src/ops.js";

const args = process.argv.slice(2);
const file = args.find((a) => !a.startsWith("--"));
if (!process.env.DATABASE_URL || !file || !existsSync(file)) {
  console.error("Usage: DATABASE_URL=postgres://… npm run sqlite-to-postgres -- <sqlite .db file> --yes");
  process.exit(1);
}
const check = await verifyBackup(file);
if (!check.ok) {
  console.error(`The SQLite file failed its check (${check.error ?? check.integrity}). Nothing copied.`);
  process.exit(1);
}
console.log(`SQLite file is OK: ${check.farmers} farmers, ${check.messages} messages, ${check.staff} staff.`);
if (!args.includes("--yes")) {
  console.log("Add --yes to copy it into PostgreSQL.");
  process.exit(0);
}
const db = await openDb(process.env.DATABASE_URL);
const used = (await db.get("SELECT (SELECT COUNT(*) FROM farmers) + (SELECT COUNT(*) FROM staff) AS n")).n;
if (used && !args.includes("--replace")) {
  console.error(`PostgreSQL already has ${used} farmers/staff. Add --replace to overwrite ALL its data.`);
  await db.close();
  process.exit(1);
}
const counts = await importBackup(db, file);
for (const t of TABLES) {
  const n = (await db.get(`SELECT COUNT(*) AS n FROM ${t}`)).n;
  if (n !== (counts[t] ?? 0)) throw new Error(`Row count check failed for ${t}: ${n} in PostgreSQL, ${counts[t] ?? 0} in SQLite`);
}
await db.close();
console.log(`Copied into PostgreSQL and checked: ${Object.entries(counts).map(([t, n]) => `${t} ${n}`).join(", ")}`);
