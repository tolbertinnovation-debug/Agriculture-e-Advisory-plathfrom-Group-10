// Vercel build step (vercel.json → buildCommand). Runs on every deploy:
//  1. copies the web pages to public/ so Vercel serves them fast from its CDN:
//       prototype/   → /prototype/  (officer dashboard, staff, content, USSD simulator, demo pages)
//       apps/farmer/ → /app/        (farmer app, with the shared engine.js)
//  2. if DATABASE_URL is set: brings the database up to date (migrations), then
//       - DEMO_MODE=1:                 adds the demo farmers and demo staff logins (once)
//       - ADMIN_EMAIL + ADMIN_PASSWORD: creates the first admin if that email has no account yet
// Without DATABASE_URL the pages still deploy; the API answers "not ready" until a database is added.
import { cpSync, mkdirSync, rmSync, copyFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "../../..");
const out = resolve(root, "public");
const env = process.env;

rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });
cpSync(resolve(root, "prototype"), resolve(out, "prototype"), { recursive: true });
cpSync(resolve(root, "apps/farmer"), resolve(out, "app"), { recursive: true });
copyFileSync(resolve(root, "services/api/src/engine.js"), resolve(out, "app/engine.js"));
console.log("Pages copied to public/ (/prototype and /app).");

if (!env.DATABASE_URL) {
  console.warn("DATABASE_URL is not set: the pages are deployed, but the API will say 'not ready'.");
  console.warn("Add a database: Vercel → your project → Storage → Create → Neon (Postgres), then redeploy.");
  process.exit(0);
}

const { openDb } = await import("../src/db.js");
const db = await openDb(env.DATABASE_URL, { max: 1 });
console.log("Database up to date (migrations applied).");

try {
  if (env.DEMO_MODE === "1") {
    if ((env.SMS_PROVIDER ?? "log") !== "log") throw new Error("DEMO_MODE=1 is only allowed with SMS_PROVIDER=log");
    const hasStaff = await db.get("SELECT 1 AS x FROM staff LIMIT 1");
    if (!hasStaff) {
      // The seed script refuses to run in production; the demo database is the one place it is meant for.
      const r = spawnSync(process.execPath, ["--no-warnings=ExperimentalWarning", resolve(here, "seed.js")], {
        env: { ...env, NODE_ENV: "development" }, stdio: "inherit"
      });
      if (r.status !== 0) throw new Error("Adding the demo data failed");
    } else console.log("Demo data: staff accounts already exist, nothing added.");
  }
  if (env.ADMIN_EMAIL && env.ADMIN_PASSWORD) {
    const { createStaff } = await import("../src/staff.js");
    const email = env.ADMIN_EMAIL.trim().toLowerCase();
    if (await db.get("SELECT 1 AS x FROM staff WHERE email = ?", email)) console.log(`Admin ${email} already exists: ADMIN_PASSWORD is not used again. You can delete it from the Vercel settings now.`);
    else {
      await createStaff(db, { email, name: env.ADMIN_NAME || "Administrator", role: "admin", password: env.ADMIN_PASSWORD });
      console.log(`Admin ${email} created. Log in, set up 2-step login, then delete ADMIN_PASSWORD from the Vercel settings.`);
    }
  }
} finally {
  await db.close();
}
