// The Vercel (serverless) version of AgriConnect: same app, background work done in short bursts.
import { test } from "node:test";
import assert from "node:assert/strict";
import { checkSettings, createServerlessApp } from "../src/serverless.js";
import { createApp } from "../src/app.js";
import { createStaff } from "../src/staff.js";
import { pilotReadiness } from "../src/preflight.js";
import { content, newDb } from "./helpers.js";

const logProvider = () => {
  const sent = [];
  return { name: "log", sent, async send({ to, body }) { sent.push({ to, body }); return { ok: true, id: `p-${sent.length}` }; } };
};

async function serve(env = {}, { provider = logProvider() } = {}) {
  const db = await newDb();
  const pending = [];
  const app = createServerlessApp({ db, content, provider, env: { WEATHER: "off", ...env }, waitUntil: (p) => pending.push(p) });
  const server = await new Promise((ok) => { const s = app.listen(0, () => ok(s)); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = async (method, path, body, headers = {}) => {
    const res = await fetch(base + path, { method, redirect: "manual", headers: { ...(body ? { "Content-Type": "application/json" } : {}), ...headers }, body: body ? JSON.stringify(body) : undefined });
    const type = res.headers.get("content-type") ?? "";
    return { status: res.status, headers: res.headers, body: type.includes("json") ? await res.json() : await res.text() };
  };
  // The response can reach the client a moment before the server's "finish" event schedules the work.
  const settle = async () => { await new Promise((r) => setTimeout(r, 30)); while (pending.length) await pending.shift(); };
  return { db, provider, call, settle, close: async () => { await settle(); await new Promise((ok) => server.close(ok)); await db.close(); } };
}

test("unsafe or missing settings are refused before anything starts", () => {
  const log = { name: "log" };
  const real = { name: "africastalking" };
  assert.match(checkSettings({}, log)[0], /DATABASE_URL is not set/);
  assert.deepEqual(checkSettings({ DATABASE_URL: "postgres://x" }, log), []);
  assert.ok(checkSettings({ DATABASE_URL: "postgres://x", STAFF_AUTH: "off" }, log).some((m) => /STAFF_AUTH/.test(m)));
  assert.ok(checkSettings({ DATABASE_URL: "postgres://x" }, real).some((m) => /WEBHOOK_SECRET/.test(m)));
  assert.ok(checkSettings({ DATABASE_URL: "postgres://x", WEBHOOK_SECRET: "s", DEMO_MODE: "1" }, real).some((m) => /DEMO_MODE/.test(m)));
});

test("after a request, queued SMS are sent without any background process", async () => {
  const s = await serve();
  try {
    // Registering on *347# queues a welcome SMS and the first advice.
    const r = await s.call("POST", "/ussd", { phoneNumber: "0777000001", text: "1*1*2*1*5*1" });
    assert.equal(r.status, 200);
    await s.settle();
    const left = await s.db.get("SELECT COUNT(*) AS n FROM message_log WHERE status = 'queued'");
    assert.equal(Number(left.n), 0);
    // (Rice planted in May is between seasons in some months, so only the welcome may be due.)
    assert.ok(s.provider.sent.length >= 1, "the welcome SMS was sent");
    assert.match(s.provider.sent[0].body, /Welcome to AgriConnect/);
  } finally { await s.close(); }
});

test("the daily job needs CRON_SECRET, then runs advice, feedback, escalation, a restore drill and the SMS queue", async () => {
  const s = await serve({ CRON_SECRET: "cron-secret-123" });
  try {
    assert.equal((await s.call("GET", "/api/cron/daily")).status, 401);
    assert.equal((await s.call("GET", "/api/cron/daily", null, { Authorization: "Bearer wrong-secret-12" })).status, 401);
    await s.call("POST", "/ussd", { phoneNumber: "0777000001", text: "1*1*2*1*5*1" });
    const r = await s.call("GET", "/api/cron/daily", null, { Authorization: "Bearer cron-secret-123" });
    assert.equal(r.status, 200);
    assert.ok(r.body.done.advice, "advice job ran");
    assert.ok(r.body.done.feedback, "feedback job ran");
    assert.equal(r.body.done.restore_drill.ok, true);
    assert.equal(r.body.done.weather, undefined); // WEATHER=off in this test
    // A second call the same day does not send the daily advice twice.
    const again = await s.call("GET", "/api/cron/daily", null, { Authorization: "Bearer cron-secret-123" });
    assert.equal(again.body.done.advice, "already ran today");
  } finally { await s.close(); }
  const off = await serve({}); // no CRON_SECRET set: never open
  try { assert.equal((await off.call("GET", "/api/cron/daily", null, { Authorization: "Bearer undefined" })).status, 401); }
  finally { await off.close(); }
});

test("normal mode: production rules (no sign-in codes on screen); demo mode shows them and the demo start page", async () => {
  const normal = await serve();
  try {
    assert.equal((await normal.call("GET", "/")).headers.get("location"), "/app/");
    const code = await normal.call("POST", "/api/auth/request-code", { phone: "0777000001" });
    assert.equal(code.body.dev_code, undefined);
    assert.equal((await normal.call("GET", "/api/messages?phone=0777000001")).status, 401);
    assert.equal((await normal.call("GET", "/health")).body.demo, undefined);
  } finally { await normal.close(); }

  const demo = await serve({ DEMO_MODE: "1" });
  try {
    assert.equal((await demo.call("GET", "/")).headers.get("location"), "/prototype/demo.html");
    assert.equal((await demo.call("GET", "/health")).body.demo, true);
    assert.match((await demo.call("POST", "/api/auth/request-code", { phone: "0777000001" })).body.dev_code, /^\d{6}$/);
    assert.equal((await demo.call("GET", "/api/messages?phone=0777000001")).status, 200);
  } finally { await demo.close(); }

  const db = await newDb();
  try { assert.throws(() => createApp({ db, content, providerName: "africastalking", demoMode: true }), /DEMO_MODE=1 is only allowed/); }
  finally { await db.close(); }
});

test("the readiness check blocks the pilot while demo mode is on", async () => {
  const db = await newDb();
  try {
    const r = await pilotReadiness(db, content, { env: { DEMO_MODE: "1", HOSTING: "vercel" } });
    assert.equal(r.checks.find((c) => c.name === "Demo mode is off").ok, false);
    assert.equal(r.checks.find((c) => c.name === "Demo mode is off").blocking, true);
    assert.ok(r.checks.find((c) => c.name === "Database backups are on"), "on Vercel the database host keeps the backups");
  } finally { await db.close(); }
});

test("admins can download a checked backup to keep off the server; officers cannot", async () => {
  const s = await serve();
  try {
    await createStaff(s.db, { email: "admin@test.lr", name: "Admin", role: "admin", password: "correct-horse-battery" });
    await createStaff(s.db, { email: "o@test.lr", name: "Officer", role: "officer", counties: ["Bong"], password: "correct-horse-battery" });
    const token = async (email) => (await s.call("POST", "/api/staff/login", { email, password: "correct-horse-battery" })).body.token;
    const admin = await token("admin@test.lr");
    const dl = await s.call("GET", "/api/admin/backup/download", null, { Authorization: `Bearer ${admin}` });
    assert.equal(dl.status, 200);
    assert.match(dl.headers.get("content-disposition"), /attachment; filename="?agriconnect-\d{8}-\d{6}\.(db|jsonl\.gz)"?/);
    assert.equal((await s.call("GET", "/api/admin/backup/download", null, { Authorization: `Bearer ${await token("o@test.lr")}` })).status, 403);
    assert.equal(Number((await s.db.get("SELECT COUNT(*) AS n FROM audit_log WHERE action = 'backup.download'")).n), 1);
  } finally { await s.close(); }
});
