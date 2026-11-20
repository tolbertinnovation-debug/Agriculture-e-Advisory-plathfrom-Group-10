import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { createApp } from "../src/app.js";
import { createStaff } from "../src/staff.js";
import { content, newDb } from "./helpers.js";

let server, base, db, clock;
const PW = "correct-horse-battery";
beforeEach(async () => {
  db = await newDb();
  clock = new Date("2026-06-05T08:00:00Z");
  const app = createApp({ db, content, now: () => clock, staffAuth: true, webhookSecret: "", providerName: "log", rateLimits: false });
  server = await new Promise((ok) => { const s = app.listen(0, () => ok(s)); });
  base = `http://127.0.0.1:${server.address().port}`;
  await createStaff(db, { email: "admin@test.lr", name: "Admin", role: "admin", password: PW });
  await createStaff(db, { email: "mulbah@test.lr", name: "Officer Mulbah", role: "officer", counties: ["Bong"], password: PW });
  await createStaff(db, { email: "lead1@test.lr", name: "Lead Farmer Kerkula", role: "lead", counties: ["Bong"], password: PW });
  await createStaff(db, { email: "lead2@test.lr", name: "Lead Farmer Two", role: "lead", counties: ["Bong"], password: PW });
});
afterEach(async () => { await new Promise((ok) => server.close(ok)); await db.close(); });

async function call(method, path, body, token) {
  const res = await fetch(base + path, {
    method,
    headers: { ...(body ? { "Content-Type": "application/json" } : {}), ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body ? JSON.stringify(body) : undefined
  });
  const text = await res.text();
  let json; try { json = JSON.parse(text); } catch { json = text; }
  return { status: res.status, body: json };
}
const tokenOf = async (email) => (await call("POST", "/api/staff/login", { email, password: PW })).body.token;
const KOLLIE = { phone: "0777 123 456", name: "Kollie", county: "Bong", district: "Salala", crops: [{ crop: "rice", planting_month: 5 }] };
const inbox = async (phone = "+231777123456") => (await db.all("SELECT body FROM message_log WHERE phone = ? AND direction = 'out' ORDER BY id", phone)).map((m) => m.body);
const farmers = async () => (await db.get("SELECT COUNT(*) AS n FROM farmers")).n;
const ussd = async (text, phoneNumber = "0777123456") => (await call("POST", "/ussd", { phoneNumber, text })).body;
const sms = (text, from = "0777123456") => call("POST", "/sms/inbound", { from, text });

test("an officer registers a farmer: nothing is kept as a farmer until they reply YES", async () => {
  const officer = await tokenOf("mulbah@test.lr");
  const r = await call("POST", "/api/registrations", KOLLIE, officer);
  assert.equal(r.status, 201);
  assert.equal(r.body.status, "waiting");
  assert.equal(await farmers(), 0);
  const [invite] = await inbox();
  assert.match(invite, /^AgriConnect: Officer Mulbah registered you for free Rice advice in Bong\. Reply YES to join or NO to refuse\./);
  assert.ok(invite.length <= 160);

  await sms("yes");
  const f = await db.get("SELECT * FROM farmers WHERE phone = '+231777123456'");
  assert.equal(f.channel, "assisted");
  assert.equal(f.registered_by, "Officer Mulbah");
  assert.equal(f.name, "Kollie");
  assert.ok(f.consent_at, "consent = the farmer's own YES");
  assert.match((await inbox())[1], /^Welcome to AgriConnect!/);
  const [reg] = (await call("GET", "/api/registrations", null, officer)).body;
  assert.equal(reg.status, "joined");
  assert.equal(reg.farmer_id, f.id);
});

test("NO refuses: no farmer, and a later YES is just a normal message", async () => {
  await call("POST", "/api/registrations", KOLLIE, await tokenOf("mulbah@test.lr"));
  await sms("NO");
  assert.equal(await farmers(), 0);
  assert.match((await inbox()).at(-1), /You are not registered/);
  await sms("YES");
  assert.equal(await farmers(), 0);
  assert.match((await inbox()).at(-1), /dial \*347#/);
});

test("the farmer can also answer on *347#", async () => {
  await call("POST", "/api/registrations", { ...KOLLIE, crops: [{ crop: "rice", planting_month: 5 }, { crop: "cassava", planting_month: 4 }] }, await tokenOf("lead1@test.lr"));
  const screen = await ussd("");
  assert.match(screen, /^CON Lead Farmer Kerkula registered you for free Rice & Cassava advice in Bong\. Join\?\n1 Yes, join \(free\)\n2 No$/);
  assert.match(await ussd("1"), /^END Welcome! You are registered\./);
  assert.equal(await farmers(), 1);
  assert.match(await ussd(""), /^CON AgriConnect - Bong/, "now the normal menu");
});

test("officers and lead farmers can only register in their own counties", async () => {
  assert.equal((await call("POST", "/api/registrations", { ...KOLLIE, county: "Lofa" }, await tokenOf("mulbah@test.lr"))).status, 403);
  assert.equal((await call("POST", "/api/registrations", { ...KOLLIE, county: "Lofa" }, await tokenOf("lead1@test.lr"))).status, 403);
  assert.equal((await call("POST", "/api/registrations", { ...KOLLIE, county: "Lofa" }, await tokenOf("admin@test.lr"))).status, 201);
});

test("lead farmers see only their own registrations; officers see their county's", async () => {
  const lead1 = await tokenOf("lead1@test.lr");
  const lead2 = await tokenOf("lead2@test.lr");
  await call("POST", "/api/registrations", KOLLIE, lead1);
  await call("POST", "/api/registrations", { ...KOLLIE, phone: "0777000222", name: "Musu" }, lead2);
  assert.deepEqual((await call("GET", "/api/registrations", null, lead1)).body.map((r) => r.details.name), ["Kollie"]);
  assert.equal((await call("GET", "/api/registrations", null, await tokenOf("mulbah@test.lr"))).body.length, 2);
  // Lead farmers cannot see farmer lists, reports or questions
  for (const path of ["/api/farmers", "/api/pest-reports", "/api/questions", "/api/stats"]) assert.equal((await call("GET", path, null, lead1)).status, 403, path);
  const other = (await call("GET", "/api/registrations", null, lead2)).body[0];
  assert.equal((await call("POST", `/api/registrations/${other.id}/resend`, {}, lead1)).status, 403);
});

test("resend at most 3 invitations in total; cancel stops it", async () => {
  const lead = await tokenOf("lead1@test.lr");
  const reg = (await call("POST", "/api/registrations", KOLLIE, lead)).body;
  assert.equal((await call("POST", `/api/registrations/${reg.id}/resend`, {}, lead)).body.sms_sent, 2);
  assert.equal((await call("POST", `/api/registrations/${reg.id}/resend`, {}, lead)).body.sms_sent, 3);
  const fourth = await call("POST", `/api/registrations/${reg.id}/resend`, {}, lead);
  assert.equal(fourth.status, 400);
  assert.match(fourth.body.details[0], /already sent 3 times/);
  assert.equal((await inbox()).length, 3);
  assert.equal((await call("POST", `/api/registrations/${reg.id}/cancel`, {}, lead)).status, 200);
  await sms("YES");
  assert.equal(await farmers(), 0, "a cancelled invitation cannot be accepted");
});

test("invitations expire after 7 days", async () => {
  await call("POST", "/api/registrations", KOLLIE, await tokenOf("mulbah@test.lr"));
  clock = new Date(clock.getTime() + 8 * 86400000);
  assert.match(await ussd(""), /^CON Welcome to AgriConnect Liberia/);
  await sms("YES");
  assert.equal(await farmers(), 0);
  const [reg] = (await call("GET", "/api/registrations", null, await tokenOf("admin@test.lr"))).body;
  assert.equal(reg.status, "expired");
});

test("a phone that is already a farmer cannot be invited; a new invitation replaces a waiting one", async () => {
  const officer = await tokenOf("mulbah@test.lr");
  await call("POST", "/api/registrations", KOLLIE, officer);
  await call("POST", "/api/registrations", { ...KOLLIE, name: "Kollie M." }, officer);
  const regs = (await call("GET", "/api/registrations", null, officer)).body;
  assert.deepEqual(regs.map((r) => r.status), ["waiting", "cancelled"]);
  await sms("YES");
  assert.equal((await db.get("SELECT name FROM farmers")).name, "Kollie M.");
  const again = await call("POST", "/api/registrations", KOLLIE, officer);
  assert.equal(again.status, 400);
  assert.match(again.body.details[0], /already registered/);
});

test("only admins add farmers directly (e.g. from signed paper forms); officers use invitations", async () => {
  const body = { ...KOLLIE, consent: true };
  assert.equal((await call("POST", "/api/farmers", body, await tokenOf("mulbah@test.lr"))).status, 403);
  assert.equal((await call("POST", "/api/farmers", body, await tokenOf("admin@test.lr"))).status, 201);
});
