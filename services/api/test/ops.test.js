import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../src/app.js";
import { createStaff } from "../src/staff.js";
import { cleanFarmerInput, createFarmer } from "../src/farmers.js";
import { backupDatabase, verifyBackup, listBackupFiles, recordError, resetAlertThrottle, systemStatus, recentErrors } from "../src/ops.js";
import { backupDue } from "../src/scheduler.js";
import { content, newDb } from "./helpers.js";

// SQLite backups are .db copies; PostgreSQL backups are .jsonl.gz files with every row.
const EXT = () => (db.dialect === "sqlite" ? ".db" : ".jsonl.gz");

let db, dir;
beforeEach(async () => {
  db = await newDb();
  dir = mkdtempSync(join(tmpdir(), "agriconnect-backups-"));
  resetAlertThrottle();
});
const addFarmer = async (phone) => (await createFarmer(db, cleanFarmerInput({ phone, county: "Bong", consent: true, crops: [{ crop: "rice", planting_month: 5 }] }, content)));

async function serve(opts = {}) {
  const app = createApp({ db, content, webhookSecret: "", providerName: "log", ...opts });
  const server = await new Promise((ok) => { const s = app.listen(0, () => ok(s)); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = async (method, path, body, headers = {}) => {
    const res = await fetch(base + path, { method, headers: { ...(body ? { "Content-Type": "application/json" } : {}), ...headers }, body: body ? JSON.stringify(body) : undefined });
    return { status: res.status, headers: res.headers, body: await res.json().catch(() => null) };
  };
  return { call, close: () => new Promise((ok) => server.close(ok)) };
}

// ---------------------------------------------------------------- backups
test("a backup is a checked, complete copy of the live database", async () => {
  (await addFarmer("0777000001"));
  (await addFarmer("0777000002"));
  const r = (await backupDatabase(db, dir, { now: new Date("2026-11-20T02:00:00Z") }));
  assert.equal(r.ok, true);
  assert.equal(r.integrity, "ok");
  assert.equal(r.farmers, 2);
  assert.ok(r.file.endsWith(`agriconnect-20261120-020000${EXT()}`), r.file);
  assert.equal((await verifyBackup(r.file)).farmers, 2);
});

test("only the newest backups are kept", async () => {
  for (let d = 1; d <= 5; d++) (await backupDatabase(db, dir, { now: new Date(`2026-11-0${d}T02:00:00Z`), keep: 3 }));
  assert.deepEqual(listBackupFiles(dir).map((f) => f.name), [
    `agriconnect-20261105-020000${EXT()}`, `agriconnect-20261104-020000${EXT()}`, `agriconnect-20261103-020000${EXT()}`
  ]);
});

test("a damaged backup file fails its check", async () => {
  const bad = join(dir, "agriconnect-broken.db");
  writeFileSync(bad, "this is not a database");
  assert.equal((await verifyBackup(bad)).ok, false);
});

test("the daily backup is due once a day after the set hour", async () => {
  assert.equal((await backupDue(db, new Date("2026-11-20T01:59:00Z"), 2)), false);
  assert.equal((await backupDue(db, new Date("2026-11-20T02:01:00Z"), 2)), true);
  (await backupDatabase(db, dir, { now: new Date("2026-11-20T02:01:00Z") }));
  assert.equal((await backupDue(db, new Date("2026-11-20T23:00:00Z"), 2)), false);
  assert.equal((await backupDue(db, new Date("2026-11-21T02:00:00Z"), 2)), true);
});

// ---------------------------------------------------------------- errors & status
test("errors are logged, and alerts are sent at most once every 5 minutes", async () => {
  const sent = [];
  const fakeFetch = async (url, opts) => { sent.push(JSON.parse(opts.body).text); return { ok: true }; };
  const t0 = new Date("2026-11-20T10:00:00Z");
  const quiet = { log: console.error };
  console.error = () => {};
  try {
    (await recordError(db, new Error("first"), { path: "/api/x", method: "GET" }, { webhookUrl: "https://hooks.example/abc", fetch: fakeFetch, now: t0 }));
    (await recordError(db, new Error("second"), {}, { webhookUrl: "https://hooks.example/abc", fetch: fakeFetch, now: new Date(t0.getTime() + 60000) }));
    (await recordError(db, new Error("third"), {}, { webhookUrl: "https://hooks.example/abc", fetch: fakeFetch, now: new Date(t0.getTime() + 6 * 60000) }));
  } finally { console.error = quiet.log; }
  await new Promise((r) => setTimeout(r, 10));
  assert.deepEqual(sent, ["AgriConnect error: first [GET /api/x]", "AgriConnect error: third (+1 more since the last alert)"]);
  assert.deepEqual((await recentErrors(db)).map((e) => e.message), ["third", "second", "first"]);
});

test("system status warns about missing backups, fake SMS and errors", async () => {
  const s = (await systemStatus(db, { now: new Date(), backupDir: undefined, smsProvider: "log" }));
  assert.equal(s.ok, false);
  assert.ok(s.warnings.some((w) => w.includes("Backups are off")));
  assert.ok(s.warnings.some((w) => w.includes("NOT sent to real phones")));
  (await backupDatabase(db, dir));
  const s2 = (await systemStatus(db, { now: new Date(), backupDir: dir, smsProvider: "africastalking" }));
  assert.equal(s2.backup.ok, true);
  assert.ok(!s2.warnings.some((w) => w.includes("backup")));
});

// ---------------------------------------------------------------- HTTP hardening
test("security headers on every response; no X-Powered-By", async () => {
  const s = await serve({ staffAuth: false, production: true });
  try {
    const r = await s.call("GET", "/health");
    assert.equal(r.headers.get("x-content-type-options"), "nosniff");
    assert.equal(r.headers.get("x-frame-options"), "DENY");
    assert.match(r.headers.get("strict-transport-security"), /max-age/);
    assert.equal(r.headers.get("x-powered-by"), null);
  } finally { await s.close(); }
});

test("CORS: open in development, closed in production unless allowed", async () => {
  const dev = await serve({ staffAuth: false });
  try { assert.equal((await dev.call("GET", "/health", null, { Origin: "http://x.test" })).headers.get("access-control-allow-origin"), "*"); }
  finally { await dev.close(); }
  const prod = await serve({ staffAuth: false, production: true });
  try { assert.equal((await prod.call("GET", "/health", null, { Origin: "http://evil.test" })).headers.get("access-control-allow-origin"), null); }
  finally { await prod.close(); }
  const allowed = await serve({ staffAuth: false, production: true, corsOrigins: ["https://partner.test"] });
  try { assert.equal((await allowed.call("GET", "/health", null, { Origin: "https://partner.test" })).headers.get("access-control-allow-origin"), "https://partner.test"); }
  finally { await allowed.close(); }
});

test("one address cannot hammer the login: 20 tries per 10 minutes", async () => {
  const s = await serve();
  try {
    for (let i = 0; i < 20; i++) await s.call("POST", "/api/staff/login", { email: `x${i}@test.lr`, password: "wrong-password" });
    const r = await s.call("POST", "/api/staff/login", { email: "y@test.lr", password: "wrong-password" });
    assert.equal(r.status, 429);
    assert.ok(Number(r.headers.get("retry-after")) > 0);
  } finally { await s.close(); }
});

test("/ready checks the database; unexpected errors are logged, not shown", async () => {
  const s = await serve({ staffAuth: false });
  const quiet = console.error;
  console.error = () => {};
  try {
    assert.equal((await s.call("GET", "/ready")).body.ok, true);
    await db.exec("DROP TABLE broadcasts"); // simulate a broken database
    const r = await s.call("GET", "/api/broadcasts");
    assert.equal(r.status, 500);
    assert.equal(r.body.error, "Something went wrong");
    assert.match((await recentErrors(db))[0].message, /no such table|does not exist/);
    assert.equal((await recentErrors(db))[0].context.path, "/api/broadcasts");
  } finally { console.error = quiet; await s.close(); }
});

test("admin status and backup-now are admin-only", async () => {
  (await createStaff(db, { email: "admin@test.lr", name: "A", role: "admin", password: "correct-horse-battery" }));
  (await createStaff(db, { email: "off@test.lr", name: "O", role: "officer", counties: ["Bong"], password: "correct-horse-battery" }));
  const s = await serve({ backupDir: dir });
  try {
    const tok = async (email) => (await s.call("POST", "/api/staff/login", { email, password: "correct-horse-battery" })).body.token;
    const admin = { Authorization: `Bearer ${await tok("admin@test.lr")}` };
    const officer = { Authorization: `Bearer ${await tok("off@test.lr")}` };
    assert.equal((await s.call("GET", "/api/admin/status", null, officer)).status, 403);
    assert.equal((await s.call("POST", "/api/admin/backup", {}, officer)).status, 403);
    const b = await s.call("POST", "/api/admin/backup", {}, admin);
    assert.equal(b.body.ok, true);
    assert.equal(readdirSync(dir).length, 1);
    const st = (await s.call("GET", "/api/admin/status", null, admin)).body;
    assert.equal(st.backup.ok, true);
    assert.equal(st.backups_kept, 1);
    assert.ok(Array.isArray(st.recent_errors));
  } finally { await s.close(); }
});

// ---------------------------------------------------------------- restore drill (Sprint 6)
test("restore drill: the newest backup is restored into a separate database and every table matches", async () => {
  const { restoreDrill } = await import("../src/ops.js");
  await db.run("INSERT INTO farmers (phone, county, consent_at) VALUES ('+231777000001', 'Bong', '2026-01-01 00:00:00')");
  const f = await db.get("SELECT id FROM farmers WHERE phone = '+231777000001'");
  await db.run("INSERT INTO farmer_crops (farmer_id, crop, planting_month) VALUES (?, 'rice', 5)", f.id);
  const before = (await systemStatus(db, { now: new Date(), backupDir: dir, smsProvider: "africastalking" })).warnings;
  assert.ok(before.some((w) => w.includes("No restore drill yet")));

  await backupDatabase(db, dir);
  const r = await restoreDrill(db, { backupDir: dir });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.farmers, 1);
  assert.deepEqual(r.differences, []);
  assert.equal((await db.get("SELECT COUNT(*) AS n FROM farmers")).n, 1); // the live database is untouched
  const s = await systemStatus(db, { now: new Date(), backupDir: dir, smsProvider: "africastalking" });
  assert.equal(s.restore_drill.ok, true);
  assert.ok(!s.warnings.some((w) => w.includes("restore drill")));

  // Without backups it makes a fresh one; a damaged backup fails the drill and says so.
  assert.equal((await restoreDrill(db, {})).ok, true);
  const { writeFileSync, readdirSync } = await import("node:fs");
  const newest = readdirSync(dir).filter((n) => n.startsWith("agriconnect-")).sort().reverse()[0];
  writeFileSync(`${dir}/${newest}`, "not a backup");
  const bad = await restoreDrill(db, { backupDir: dir });
  assert.equal(bad.ok, false);
  assert.ok((await systemStatus(db, { now: new Date(), backupDir: dir, smsProvider: "africastalking" })).warnings.some((w) => w.includes("restore drill FAILED")));
});
