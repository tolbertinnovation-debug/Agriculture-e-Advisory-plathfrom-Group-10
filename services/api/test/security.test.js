// Sprint 6 security review: tests that keep the fixes in place.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { createWriteStream } from "node:fs";
import { createGzip } from "node:zlib";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../src/app.js";
import { importBackup } from "../src/ops.js";
import { content, newDb } from "./helpers.js";

async function serve(opts = {}) {
  const db = await newDb();
  const app = createApp({ db, content, staffAuth: true, webhookSecret: "", providerName: "log", rateLimits: false, ...opts });
  const server = await new Promise((ok) => { const s = app.listen(0, () => ok(s)); });
  const base = `http://127.0.0.1:${server.address().port}`;
  return { db, app, base, close: async () => { await new Promise((ok) => server.close(ok)); await db.close(); } };
}

// Routes anyone may call. Everything else must answer 401 without a login.
const PUBLIC = new Set([
  "GET /", "GET /health", "GET /ready", "GET /app/engine.js",
  "GET /api/counties", "GET /api/content/crops", "GET /api/content/pests", "GET /api/weather", "GET /api/markets", "GET /api/prices",
  "POST /ussd", "POST /sms/inbound", "POST /sms/status", // telco webhooks: protected by WEBHOOK_SECRET instead
  "POST /api/staff/login", "POST /api/auth/request-code", "POST /api/auth/verify"
]);

test("every route except the public list needs a login (a new route can't be left open by mistake)", async () => {
  const s = await serve();
  try {
    const routes = s.app.router.stack.filter((l) => l.route).flatMap((l) => Object.keys(l.route.methods).map((m) => [m.toUpperCase(), l.route.path]));
    assert.ok(routes.length > 60, `found ${routes.length} routes`);
    const open = [];
    for (const [method, path] of routes) {
      if (PUBLIC.has(`${method} ${path}`)) continue;
      const url = path.replace(/:[a-z_]+/g, "1").replace(/\.csv$/, ".csv");
      const res = await fetch(s.base + url, { method, headers: method === "GET" ? {} : { "Content-Type": "application/json" }, body: method === "GET" ? undefined : "{}" });
      if (res.status !== 401) open.push(`${method} ${path} → ${res.status}`);
    }
    assert.deepEqual(open, [], "these routes answered without a login");
  } finally { await s.close(); }
});

test("in production the sign-in code is never shown and the message log is closed, even with the test SMS setting", async () => {
  const dev = await serve();
  const prod = await serve({ production: true });
  try {
    const ask = async (base) => (await (await fetch(base + "/api/auth/request-code", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ phone: "0777000001" }) })).json());
    assert.match((await ask(dev.base)).dev_code, /^\d{6}$/); // local demo: shown, so the demo works without phones
    assert.equal((await ask(prod.base)).dev_code, undefined);
    assert.equal((await fetch(dev.base + "/api/messages?phone=0777000001")).status, 200);
    assert.equal((await fetch(prod.base + "/api/messages?phone=0777000001")).status, 401);
  } finally { await dev.close(); await prod.close(); }
});

test("security headers include a Content-Security-Policy that only allows this server", async () => {
  const s = await serve();
  try {
    const res = await fetch(s.base + "/prototype/dashboard.html");
    const csp = res.headers.get("content-security-policy");
    assert.match(csp, /default-src 'self'/);
    assert.match(csp, /connect-src 'self'/);
    assert.match(csp, /frame-ancestors 'none'/);
    assert.match(csp, /object-src 'none'/);
    assert.equal(res.headers.get("x-content-type-options"), "nosniff");
    assert.match(res.headers.get("permissions-policy"), /camera=\(self\)/);
  } finally { await s.close(); }
});

test("a farmer can't flood officers: at most 40 questions or reports per 10 minutes per signed-in phone", async () => {
  const s = await serve({ rateLimits: true });
  try {
    const { dev_code } = await (await fetch(s.base + "/api/auth/request-code", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ phone: "0777000001" }) })).json();
    const { token } = await (await fetch(s.base + "/api/auth/verify", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ phone: "0777000001", code: dev_code }) })).json();
    const h = { "Content-Type": "application/json", Authorization: `Bearer ${token}` };
    await fetch(s.base + "/api/me/register", { method: "POST", headers: h, body: JSON.stringify({ county: "Bong", consent: true, crops: [{ crop: "rice", planting_month: 5 }] }) });
    const codes = [];
    for (let i = 0; i < 41; i++) codes.push((await fetch(s.base + "/api/me/questions", { method: "POST", headers: h, body: JSON.stringify({ body: `Question ${i}`, client_id: `q-limit-${i}` }) })).status);
    assert.equal(codes.filter((c) => c === 201).length, 40);
    assert.equal(codes.at(-1), 429);
    // Reading is not limited.
    assert.equal((await fetch(s.base + "/api/me/home", { headers: h })).status, 200);
  } finally { await s.close(); }
});

test("a tampered backup file can't run its own SQL: unknown tables and columns are refused, nothing changes", async () => {
  const db = await newDb();
  const dir = mkdtempSync(join(tmpdir(), "agri-sec-"));
  const write = async (name, lines) => {
    const file = join(dir, name);
    const gz = createGzip(); const out = createWriteStream(file); gz.pipe(out);
    for (const l of lines) gz.write(JSON.stringify(l) + "\n");
    gz.end(); await new Promise((ok) => out.on("finish", ok));
    return file;
  };
  try {
    await db.run("INSERT INTO farmers (phone, county, consent_at) VALUES ('+231777000001', 'Bong', '2026-01-01 00:00:00')");
    const head = { format: "agriconnect-backup", version: 1 };
    const badTable = await write("t.jsonl.gz", [head, { t: "farmers; DROP TABLE staff; --", r: { id: 1 } }, { end: true }]);
    await assert.rejects(importBackup(db, badTable), /unknown table/);
    const badCol = await write("c.jsonl.gz", [head, { t: "farmers", r: { "phone) VALUES ('x'); DROP TABLE staff; --": 1 } }, { end: true }]);
    await assert.rejects(importBackup(db, badCol), /unknown column/);
    // Nothing was deleted: the restore is one transaction.
    assert.equal((await db.get("SELECT COUNT(*) AS n FROM farmers")).n, 1);
    assert.ok(await db.get("SELECT COUNT(*) AS n FROM staff"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
    await db.close();
  }
});
