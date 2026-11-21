import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { createApp } from "../src/app.js";
import { createStaff, hashPassword, verifyPassword, totpAt, base32Encode, base32Decode, checkTotp, can } from "../src/staff.js";
import { content, newDb } from "./helpers.js";

let server, base, db, clock;
async function start(opts = {}) {
  db = await newDb();
  clock = new Date("2026-06-05T08:00:00Z");
  const app = createApp({ db, content, now: () => clock, staffAuth: true, webhookSecret: "", providerName: "log", ...opts });
  server = await new Promise((ok) => { const s = app.listen(0, () => ok(s)); });
  base = `http://127.0.0.1:${server.address().port}`;
}
beforeEach(() => start());
afterEach(() => new Promise((ok) => server.close(ok)));

async function call(method, path, body, token) {
  const res = await fetch(base + path, {
    method,
    headers: { ...(body ? { "Content-Type": "application/json" } : {}), ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body ? JSON.stringify(body) : undefined
  });
  return { status: res.status, body: await res.json() };
}
const PW = "correct-horse-battery";
async function account(role, counties = [], email = `${role}@test.lr`) {
  return (await createStaff(db, { email, name: role.toUpperCase(), role, counties, password: PW })).staff;
}
async function logIn(email, password = PW, code) {
  const r = await call("POST", "/api/staff/login", { email, password, code });
  return r;
}
async function tokenFor(role, counties, email) {
  (await account(role, counties, email));
  return (await logIn(email ?? `${role}@test.lr`)).body.token;
}
/** The current authenticator code for a secret, at a given time. */
const codeFor = (secret, at = clock) => totpAt(base32Decode(secret), Math.floor(at.getTime() / 30000));

// ---------------------------------------------------------------- building blocks
test("TOTP matches the RFC 6238 test vectors", async () => {
  const secret = Buffer.from("12345678901234567890");
  assert.equal(totpAt(secret, Math.floor(59 / 30), 8), "94287082");
  assert.equal(totpAt(secret, Math.floor(1111111109 / 30), 8), "07081804");
  assert.equal(totpAt(secret, Math.floor(1234567890 / 30), 8), "89005924");
  assert.deepEqual(base32Decode(base32Encode(secret)), secret);
  const b32 = base32Encode(secret);
  assert.equal(checkTotp(b32, totpAt(secret, Math.floor(clock.getTime() / 30000)), clock), Math.floor(clock.getTime() / 30000));
  assert.equal(checkTotp(b32, "12345", clock), null);
});

test("passwords are hashed with scrypt and checked safely", async () => {
  const h = hashPassword("a-long-password");
  assert.match(h, /^scrypt\$16384\$8\$1\$/);
  assert.equal(verifyPassword("a-long-password", h), true);
  assert.equal(verifyPassword("wrong-password", h), false);
  assert.notEqual(hashPassword("a-long-password"), h, "salted");
});

test("role permissions", async () => {
  assert.equal(can({ role: "admin" }, "anything"), true);
  assert.equal(can({ role: "officer" }, "broadcasts:send"), true);
  assert.equal(can({ role: "officer" }, "staff:manage"), false);
  assert.equal(can({ role: "editor" }, "prices:write"), true);
  assert.equal(can({ role: "editor" }, "reports:read"), false);
  assert.equal(can({ role: "viewer" }, "farmers:read"), false);
});

// ---------------------------------------------------------------- login
test("officer routes need a login now; public and farmer routes do not", async () => {
  assert.equal((await call("GET", "/api/stats")).status, 401);
  assert.equal((await call("GET", "/api/pest-reports")).status, 401);
  assert.equal((await call("POST", "/api/broadcasts", { message: "hi" })).status, 401);
  assert.equal((await call("GET", "/api/counties")).status, 200);
  assert.equal((await call("GET", "/api/prices")).status, 200);
  assert.equal((await call("POST", "/api/auth/request-code", { phone: "0777000001" })).status, 200);
});

test("log in, see who I am, log out", async () => {
  (await account("admin"));
  const r = await logIn("ADMIN@test.lr");
  assert.equal(r.status, 200);
  assert.equal(r.body.staff.role, "admin");
  assert.ok(r.body.staff.permissions.includes("staff:manage"));
  assert.equal((await call("GET", "/api/stats", null, r.body.token)).status, 200);
  assert.equal((await call("GET", "/api/staff/me", null, r.body.token)).body.email, "admin@test.lr");
  await call("POST", "/api/staff/logout", {}, r.body.token);
  assert.equal((await call("GET", "/api/stats", null, r.body.token)).status, 401);
});

test("wrong passwords lock the account for 15 minutes after 5 tries; unknown emails look the same", async () => {
  (await account("officer", ["Bong"]));
  assert.equal((await logIn("nobody@test.lr")).body.error, "Wrong email or password");
  for (let i = 0; i < 5; i++) assert.equal((await logIn("officer@test.lr", "wrong-password")).status, 401);
  const locked = await logIn("officer@test.lr");
  assert.equal(locked.status, 429);
  clock = new Date(clock.getTime() + 16 * 60 * 1000);
  assert.equal((await logIn("officer@test.lr")).status, 200);
});

test("sessions expire after 12 hours", async () => {
  const token = await tokenFor("admin");
  clock = new Date(clock.getTime() + 13 * 3600 * 1000);
  assert.equal((await call("GET", "/api/stats", null, token)).status, 401);
});

// ---------------------------------------------------------------- 2-step login
test("2-step login: set up, then every login needs a fresh code", async () => {
  const token = await tokenFor("admin");
  const { secret, otpauth_url } = (await call("POST", "/api/staff/me/2fa/start", {}, token)).body;
  assert.match(otpauth_url, /^otpauth:\/\/totp\/AgriConnect%3Aadmin%40test\.lr\?secret=/);
  assert.equal((await call("POST", "/api/staff/me/2fa/enable", { code: "000000" }, token)).status, 400);
  assert.equal((await call("POST", "/api/staff/me/2fa/enable", { code: codeFor(secret) }, token)).status, 200);

  clock = new Date(clock.getTime() + 60 * 1000);
  const noCode = await logIn("admin@test.lr");
  assert.equal(noCode.status, 401);
  assert.equal(noCode.body.needs_code, true);
  assert.equal((await logIn("admin@test.lr", PW, "123456")).status, 401);
  const code = codeFor(secret);
  assert.equal((await logIn("admin@test.lr", PW, code)).status, 200);
  assert.equal((await logIn("admin@test.lr", PW, code)).status, 401, "the same code cannot be used twice");
});

test("with REQUIRE_2FA, a new account can only set up 2-step login until it is on", async () => {
  await new Promise((ok) => server.close(ok));
  await start({ require2fa: true });
  (await account("officer", ["Bong"]));
  const r = await logIn("officer@test.lr");
  assert.equal(r.body.needs_2fa_setup, true);
  const blocked = await call("GET", "/api/pest-reports", null, r.body.token);
  assert.equal(blocked.status, 403);
  assert.equal(blocked.body.setup_2fa, true);
  const { secret } = (await call("POST", "/api/staff/me/2fa/start", {}, r.body.token)).body;
  await call("POST", "/api/staff/me/2fa/enable", { code: codeFor(secret) }, r.body.token);
  assert.equal((await call("GET", "/api/pest-reports", null, r.body.token)).status, 200);
  assert.equal((await call("POST", "/api/staff/me/2fa/disable", { password: PW }, r.body.token)).status, 400, "cannot switch it off");
});

// ---------------------------------------------------------------- roles & counties
async function seedReports(adminToken) {
  for (const [phone, county] of [["0880000001", "Bong"], ["0880000002", "Bong"], ["0880000003", "Bong"], ["0880000004", "Lofa"]])
    await call("POST", "/api/pest-reports", { phone, county, crop: "rice", symptoms: ["holes", "caterpillar"] }, adminToken);
}

test("officers only see and act on their own counties", async () => {
  const admin = await tokenFor("admin");
  await seedReports(admin);
  const bong = await tokenFor("officer", ["Bong"], "bong@test.lr");

  const reports = (await call("GET", "/api/pest-reports", null, bong)).body;
  assert.deepEqual([...new Set(reports.map((r) => r.county))], ["Bong"]);
  assert.equal((await call("GET", "/api/pest-reports?county=Lofa", null, bong)).status, 403);
  const lofaReport = (await call("GET", "/api/pest-reports?county=Lofa", null, admin)).body[0];
  assert.equal((await call("PATCH", `/api/pest-reports/${lofaReport.id}`, { status: "verified" }, bong)).status, 403);
  assert.equal((await call("PATCH", `/api/pest-reports/${reports[0].id}`, { status: "verified" }, bong)).status, 200);

  assert.deepEqual((await call("GET", "/api/hotspots", null, bong)).body.map((h) => h.county), ["Bong"]);
  assert.equal((await call("GET", "/api/stats", null, bong)).body.reports_to_check, 2);
  assert.equal((await call("GET", "/api/stats", null, admin)).body.reports_to_check, 3, "4 reports, 1 verified above");
});

test("officers can only message farmers in their counties", async () => {
  const admin = await tokenFor("admin");
  for (const [phone, county] of [["0777000001", "Bong"], ["0777000002", "Lofa"]])
    await call("POST", "/api/farmers", { phone, county, consent: true, crops: [{ crop: "rice", planting_month: 5 }] }, admin);
  const bong = await tokenFor("officer", ["Bong"], "bong@test.lr");
  assert.equal((await call("POST", "/api/broadcasts", { counties: ["Lofa"], message: "Hello Lofa" }, bong)).status, 403);
  assert.equal((await call("POST", "/api/broadcasts/preview", {}, bong)).body.reach, 1, "no county = the officer's own counties");
  const sent = await call("POST", "/api/broadcasts", { message: "Hello Bong farmers" }, bong);
  assert.equal(sent.status, 201);
  assert.deepEqual(sent.body.counties, ["Bong"]);
  assert.equal(sent.body.sent_by, "OFFICER");
  assert.equal((await call("POST", "/api/farmers", { phone: "0777000003", county: "Lofa", consent: true, crops: [{ crop: "rice", planting_month: 5 }] }, bong)).status, 403);
});

test("viewers see numbers only; editors manage prices but not farmers", async () => {
  const viewer = await tokenFor("viewer");
  assert.equal((await call("GET", "/api/stats", null, viewer)).status, 200);
  assert.equal((await call("GET", "/api/farmers", null, viewer)).status, 403);
  assert.equal((await call("GET", "/api/questions", null, viewer)).status, 403);
  const editor = await tokenFor("editor");
  assert.equal((await call("POST", "/api/prices", { market: "GBARNGA", item: "RICE", price: 45 }, editor)).status, 201);
  assert.equal((await call("GET", "/api/pest-reports", null, editor)).status, 403);
  assert.equal((await call("POST", "/api/broadcasts", { message: "hi" }, editor)).status, 403);
});

test("message log: open for one phone in development, admin-only otherwise", async () => {
  const officer = await tokenFor("officer", ["Bong"]);
  assert.equal((await call("GET", "/api/messages?phone=0777000001")).status, 200);
  assert.equal((await call("GET", "/api/messages")).status, 401);
  assert.equal((await call("GET", "/api/messages", null, officer)).status, 403);
  await new Promise((ok) => server.close(ok));
  await start({ providerName: "africastalking" });
  assert.equal((await call("GET", "/api/messages?phone=0777000001")).status, 401);
});

// ---------------------------------------------------------------- admin tools & audit
test("admins create, change and switch off accounts; everything is in the audit log", async () => {
  const admin = await tokenFor("admin");
  const officerTok = await tokenFor("officer", ["Bong"], "first@test.lr");
  assert.equal((await call("GET", "/api/staff", null, officerTok)).status, 403);

  assert.equal((await call("POST", "/api/staff", { email: "x@test.lr", name: "X", role: "officer", counties: [] }, admin)).status, 400, "officer needs counties");
  const created = await call("POST", "/api/staff", { email: "Mulbah@Test.lr", name: "Officer Mulbah", role: "officer", counties: ["bong", "Lofa"] }, admin);
  assert.equal(created.status, 201);
  assert.deepEqual(created.body.staff.counties, ["Bong", "Lofa"]);
  assert.ok(created.body.password.length >= 10, "a one-time password is returned");
  const mulbah = (await logIn("mulbah@test.lr", created.body.password)).body.token;
  assert.ok(mulbah);

  const id = created.body.staff.id;
  assert.deepEqual((await call("PATCH", `/api/staff/${id}`, { counties: ["Nimba"] }, admin)).body.counties, ["Nimba"]);
  await call("PATCH", `/api/staff/${id}`, { active: false }, admin);
  assert.equal((await call("GET", "/api/stats", null, mulbah)).status, 401, "switched-off staff are logged out at once");
  assert.equal((await logIn("mulbah@test.lr", created.body.password)).status, 401);

  const self = (await call("GET", "/api/staff/me", null, admin)).body.id;
  assert.equal((await call("PATCH", `/api/staff/${self}`, { active: false }, admin)).status, 400, "cannot lock yourself out");

  const reset = await call("POST", `/api/staff/${id}/reset-password`, {}, admin);
  await call("PATCH", `/api/staff/${id}`, { active: true }, admin);
  assert.equal((await logIn("mulbah@test.lr", reset.body.password)).status, 200);

  await logIn("admin@test.lr", "wrong-password");
  const actions = (await call("GET", "/api/audit", null, admin)).body.map((a) => a.action);
  for (const a of ["login", "login.failed", "staff.create", "staff.update", "staff.reset_password"]) assert.ok(actions.includes(a), a);
});

test("officer actions are recorded with who did them", async () => {
  const admin = await tokenFor("admin");
  await seedReports(admin);
  const bong = await tokenFor("officer", ["Bong"], "bong@test.lr");
  const [r] = (await call("GET", "/api/pest-reports", null, bong)).body;
  await call("PATCH", `/api/pest-reports/${r.id}`, { status: "verified" }, bong);
  await call("POST", "/api/broadcasts", { message: "Check your fields this week." }, bong);
  const log = (await call("GET", "/api/audit", null, admin)).body;
  const verified = log.find((a) => a.action === "report.verified");
  assert.equal(verified.staff_email, "bong@test.lr");
  assert.equal(verified.target, `PR-${r.id}`);
  assert.equal(log.find((a) => a.action === "broadcast.send").detail.message, "Check your fields this week.");
});

test("changing your own password needs the current one and logs you out", async () => {
  const token = await tokenFor("officer", ["Bong"]);
  assert.equal((await call("POST", "/api/staff/me/password", { current: "nope", new: "another-long-password" }, token)).status, 400);
  assert.equal((await call("POST", "/api/staff/me/password", { current: PW, new: "short" }, token)).status, 400);
  assert.equal((await call("POST", "/api/staff/me/password", { current: PW, new: "another-long-password" }, token)).status, 200);
  assert.equal((await call("GET", "/api/stats", null, token)).status, 401);
  assert.equal((await logIn("officer@test.lr", "another-long-password")).status, 200);
});
