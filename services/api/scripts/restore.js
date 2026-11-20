// Restore the database from a backup file.
// 1. STOP the server first (docker compose stop api).
// 2. npm run restore -- /backups/agriconnect-20261120-020000.jsonl.gz --yes
// 3. Start the server again.
//
// Works for both databases and both backup kinds (.db and .jsonl.gz).
// SQLite: the current file is kept as <db>.before-restore-<time>.
// PostgreSQL: make a fresh backup first (npm run backup); the restore replaces all rows in one
// transaction, so if it fails half-way nothing changes.
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { copyFileSync, existsSync } from "node:fs";
import { openDb } from "../src/db.js";
import { verifyBackup, importBackup } from "../src/ops.js";

const here = dirname(fileURLToPath(import.meta.url));
const pgUrl = process.env.DATABASE_URL;
const dbPath = process.env.DB_PATH ?? resolve(here, "../data/agriconnect.db");
const [file, flag] = process.argv.slice(2);
if (!file || !existsSync(file)) {
  console.error("Usage: npm run restore -- <backup file> --yes   (stop the server first)");
  process.exit(1);
}
const check = await verifyBackup(file);
if (!check.ok) {
  console.error(`This backup failed its check (${check.error ?? check.integrity}). Not restoring.`);
  process.exit(1);
}
console.log(`Backup is OK: ${check.farmers} farmers, ${check.messages} messages, ${check.staff} staff.`);
const target = pgUrl ? "the PostgreSQL database (DATABASE_URL)" : dbPath;
if (flag !== "--yes") {
  console.log(`Add --yes to replace ALL data in ${target} with it (stop the server first).`);
  process.exit(0);
}

if (!pgUrl && file.endsWith(".db")) {
  // SQLite from a SQLite copy: swap the file.
  if (existsSync(dbPath)) {
    const keep = `${dbPath}.before-restore-${new Date().toISOString().replace(/[-:]/g, "").slice(0, 15)}`;
    copyFileSync(dbPath, keep);
    console.log(`Current database kept as ${keep}`);
  }
  copyFileSync(file, dbPath);
} else {
  const db = await openDb(pgUrl || dbPath);
  const counts = await importBackup(db, file);
  await db.close();
  console.log(`Imported: ${Object.entries(counts).map(([t, n]) => `${t} ${n}`).join(", ") || "no rows"}`);
}
console.log(`Restored ${file} → ${target}. Start the server again.`);
