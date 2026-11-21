// Sprint 6: the pilot readiness check.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pilotReadiness } from "../src/preflight.js";
import { createStaff } from "../src/staff.js";
import { approveAsIs, listContent, restoreFileTexts } from "../src/contentEditor.js";
import { backupDatabase, restoreDrill } from "../src/ops.js";
import { createApp } from "../src/app.js";
import { content, newDb } from "./helpers.js";

const failing = (r) => r.checks.filter((c) => !c.ok && c.blocking).map((c) => c.name);

test("a fresh laptop setup is NOT ready, and says exactly why", async () => {
  const db = await newDb();
  try {
    const r = await pilotReadiness(db, content, { env: {} });
    assert.equal(r.ready, false);
    const f = failing(r);
    for (const name of ["Runs in production mode", "A real SMS provider is set", "Daily backups are on", "Bong: an officer covers the county",
      "Every English advice text is approved by an agronomist", "A restore drill passed in the last 30 days"]) assert.ok(f.includes(name), name);
  } finally { await db.close(); }
});

test("with the right settings, people, approved content and a passed drill, the pilot is ready", async () => {
  const db = await newDb();
  const dir = mkdtempSync(join(tmpdir(), "agri-pre-"));
  try {
    const mk = async (s) => { const { staff } = await createStaff(db, { password: "correct-horse-battery", ...s }); await db.run("UPDATE staff SET totp_enabled = 1 WHERE id = ?", staff.id); return staff; };
    await mk({ email: "a1@moa.gov.lr", name: "Admin One", role: "admin" });
    await mk({ email: "a2@moa.gov.lr", name: "Admin Two", role: "admin" });
    const agro = await mk({ email: "agro@cari.lr", name: "Agronomist", role: "agronomist" });
    await mk({ email: "bong@moa.gov.lr", name: "Officer Bong", role: "officer", counties: ["Bong"], phone: "0886000001" });
    const demo = await mk({ email: "admin@agriconnect.test", name: "Demo", role: "admin" });
    for (const i of (await listContent(db, content)).items) await approveAsIs(db, content, agro, { item: i.item, lang: "en" });

    const env = { NODE_ENV: "production", REQUIRE_2FA: "1", SMS_PROVIDER: "africastalking", WEBHOOK_SECRET: "s3cret", BACKUP_DIR: dir };
    let r = await pilotReadiness(db, content, { env, pilotCounties: ["Bong"] });
    assert.deepEqual(failing(r), ["No demo accounts are switched on", "A checked backup from the last 30 hours", "A restore drill passed in the last 30 days"]);

    await db.run("UPDATE staff SET active = 0 WHERE id = ?", demo.id);
    await backupDatabase(db, dir);
    await restoreDrill(db, { backupDir: dir });
    r = await pilotReadiness(db, content, { env, pilotCounties: ["Bong"] });
    assert.deepEqual(failing(r), []);
    assert.equal(r.ready, true);
  } finally {
    restoreFileTexts(content);
    rmSync(dir, { recursive: true, force: true });
    await db.close();
  }
});

test("admins see the readiness list; nobody else does", async () => {
  const db = await newDb();
  const app = createApp({ db, content, staffAuth: true, webhookSecret: "", providerName: "log", rateLimits: false });
  const server = await new Promise((ok) => { const s = app.listen(0, () => ok(s)); });
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    await createStaff(db, { email: "admin@test.lr", name: "Admin", role: "admin", password: "correct-horse-battery" });
    await createStaff(db, { email: "o@test.lr", name: "Officer", role: "officer", counties: ["Bong"], password: "correct-horse-battery" });
    const token = async (email) => (await (await fetch(base + "/api/staff/login", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ email, password: "correct-horse-battery" }) })).json()).token;
    const get = async (t) => fetch(base + "/api/admin/readiness", { headers: { Authorization: `Bearer ${t}` } });
    const r = await get(await token("admin@test.lr"));
    assert.equal(r.status, 200);
    const body = await r.json();
    assert.equal(body.ready, false);
    assert.ok(body.checks.find((c) => c.name === "A real SMS provider is set").ok === false); // this test server uses 'log'
    assert.equal((await get(await token("o@test.lr"))).status, 403);
  } finally {
    await new Promise((ok) => server.close(ok));
    await db.close();
  }
});
