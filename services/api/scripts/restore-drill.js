// Restore drill: prove the backups really work, without touching the live database.
//   npm run restore-drill
// Takes the newest backup in BACKUP_DIR (or makes a fresh one), restores it into a separate
// empty database, and checks every table. Run it once a month and after every upgrade.
// The result shows on Staff & security → System status.
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { openDb } from "../src/db.js";
import { restoreDrill } from "../src/ops.js";

const here = dirname(fileURLToPath(import.meta.url));
const db = await openDb(process.env.DATABASE_URL || process.env.DB_PATH || resolve(here, "../data/agriconnect.db"));
const r = await restoreDrill(db, { backupDir: process.env.BACKUP_DIR });
await db.close();
if (r.ok) {
  console.log(`Restore drill PASSED in ${r.seconds} s: ${r.file} → ${r.rows.toLocaleString("en-US")} rows in ${r.tables} tables (${r.farmers.toLocaleString("en-US")} farmers), all matching.`);
} else {
  console.error(`Restore drill FAILED: ${r.error ?? r.differences.join("; ")}`);
  process.exit(1);
}
