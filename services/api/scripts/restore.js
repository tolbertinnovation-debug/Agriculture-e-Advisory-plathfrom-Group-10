// Restore the database from a backup file.
// 1. STOP the server first (docker compose stop api).
// 2. npm run restore -- /backups/agriconnect-20261120-020000.db --yes
// 3. Start the server again.
// The current database is kept next to it as <db>.before-restore-<time>, so a restore can be undone.
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { copyFileSync, existsSync } from "node:fs";
import { verifyBackup } from "../src/ops.js";

const here = dirname(fileURLToPath(import.meta.url));
const dbPath = process.env.DB_PATH ?? resolve(here, "../data/agriconnect.db");
const [file, flag] = process.argv.slice(2);
if (!file || !existsSync(file)) {
  console.error("Usage: npm run restore -- <backup file> --yes   (stop the server first)");
  process.exit(1);
}
const check = verifyBackup(file);
if (!check.ok) {
  console.error(`This backup failed its check (${check.error ?? check.integrity}). Not restoring.`);
  process.exit(1);
}
console.log(`Backup is OK: ${check.farmers} farmers, ${check.messages} messages, ${check.staff} staff.`);
if (flag !== "--yes") {
  console.log(`Add --yes to replace ${dbPath} with it (stop the server first).`);
  process.exit(0);
}
if (existsSync(dbPath)) {
  const keep = `${dbPath}.before-restore-${new Date().toISOString().replace(/[-:]/g, "").slice(0, 15)}`;
  copyFileSync(dbPath, keep);
  console.log(`Current database kept as ${keep}`);
}
copyFileSync(file, dbPath);
console.log(`Restored ${file} → ${dbPath}. Start the server again.`);
