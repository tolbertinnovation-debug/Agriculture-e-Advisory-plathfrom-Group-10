// Make a backup now, check it, and keep the newest BACKUP_KEEP (default 14).
// Usage: npm run backup            (writes to BACKUP_DIR, or ./backups)
// Safe while the server is running.
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { openDb } from "../src/db.js";
import { backupDatabase } from "../src/ops.js";

const here = dirname(fileURLToPath(import.meta.url));
const db = openDb(process.env.DB_PATH ?? resolve(here, "../data/agriconnect.db"));
const dir = process.env.BACKUP_DIR ?? resolve(here, "../backups");
const r = backupDatabase(db, dir, { keep: Number(process.env.BACKUP_KEEP ?? 14) });
if (!r.ok) {
  console.error(`Backup made but its check FAILED: ${r.error ?? r.integrity}\n${r.file}`);
  process.exit(1);
}
console.log(`Backup OK: ${r.file}\n  ${Math.round(r.bytes / 1024)} KB · ${r.farmers} farmers · ${r.messages} messages · ${r.staff} staff`);
if (r.removed.length) console.log(`  Removed old backups: ${r.removed.join(", ")}`);
