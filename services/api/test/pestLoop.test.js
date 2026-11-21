// Sprint 3: the pest loop. Delivery per advisory, app-only advisories, hotspot alerts to officers.
import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { createApp } from "../src/app.js";
import { createStaff, updateStaff } from "../src/staff.js";
import { cleanFarmerInput, createFarmer } from "../src/farmers.js";
import { createPestReport, updatePestReport } from "../src/pestReports.js";
import { hotspotAlertText } from "../src/hotspots.js";
import { content, newDb } from "./helpers.js";

let db, server, base;
const PW = "correct-horse-battery";
beforeEach(async () => {
  db = await newDb();
  const app = createApp({ db, content, staffAuth: true, webhookSecret: "", providerName: "log", rateLimits: false });
  server = await new Promise((ok) => { const s = app.listen(0, () => ok(s)); });
  base = `http://127.0.0.1:${server.address().port}`;
  await createStaff(db, { email: "admin@test.lr", name: "Admin", role: "admin", password: PW, phone: "0886000001" });
  await createStaff(db, { email: "nimba@test.lr", name: "Officer Nimba", role: "officer", counties: ["Nimba"], password: PW, phone: "0886000002" });
  await createStaff(db, { email: "nophone@test.lr", name: "Officer No Phone", role: "officer", counties: ["Nimba"], password: PW });
  await createStaff(db, { email: "bong@test.lr", name: "Officer Bong", role: "officer", counties: ["Bong"], password: PW, phone: "0886000003" });
  await createStaff(db, { email: "editor@test.lr", name: "Editor", role: "editor", password: PW, phone: "0886000004" });
});
afterEach(async () => { await new Promise((ok) => server.close(ok)); await db.close(); });

async function call(method, path, token, body) {
  const res = await fetch(base + path, { method, headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(body ? { "Content-Type": "application/json" } : {}) }, body: body ? JSON.stringify(body) : undefined });
  return { status: res.status, body: await res.json() };
}
const tokenOf = async (email) => (await call("POST", "/api/staff/login", null, { email, password: PW })).body.token;
const addFarmer = (phone, county, crops = ["rice"], extra = {}) =>
  createFarmer(db, cleanFarmerInput({ phone, county, consent: true, channel: "ussd", crops: crops.map((crop) => ({ crop, planting_month: 5 })), ...extra }, content));
const armyworm = (phone, county) => createPestReport(db, content, { phone, county, crop: "rice", symptoms: ["holes", "caterpillar"], channel: "ussd" });
const alertsTo = async (phone) => (await db.all("SELECT body FROM message_log WHERE phone = ? AND kind = 'alert'", phone)).map((m) => m.body);

test("each advisory shows its SMS delivery: queued, delivered, failed and the delivery rate", async () => {
  for (const p of ["0777000001", "0777000002", "0777000003", "0777000004"]) await addFarmer(p, "Bong");
  const officer = await tokenOf("bong@test.lr");
  const sent = await call("POST", "/api/broadcasts", officer, { counties: ["Bong"], message: "Fall armyworm seen near Gbarnga. Check your rice this week." });
  assert.equal(sent.status, 201);
  assert.equal(sent.body.queued, 4);
  assert.deepEqual(sent.body.sms, { queued: 4, sending: 0, sent: 0, delivered: 0, failed: 0, total: 4, delivery_rate: 0 });

  // Delivery reports come back from the SMS provider.
  const ids = (await db.all("SELECT id FROM message_log WHERE broadcast_id = ? ORDER BY id", sent.body.id)).map((m) => m.id);
  assert.equal(ids.length, 4);
  await db.run(`UPDATE message_log SET status = 'delivered' WHERE id IN (?, ?, ?)`, ids[0], ids[1], ids[2]);
  await db.run(`UPDATE message_log SET status = 'failed' WHERE id = ?`, ids[3]);
  // Other SMS (a pest reply) are not counted in the advisory.
  await armyworm("0777000001", "Bong");

  const [b] = (await call("GET", "/api/broadcasts", officer)).body;
  assert.equal(b.sms.delivered, 3);
  assert.equal(b.sms.failed, 1);
  assert.equal(b.sms.total, 4);
  assert.equal(b.sms.delivery_rate, 0.75);
});

test("an app-only advisory costs no SMS; voice is refused until it exists", async () => {
  for (const p of ["0777000001", "0777000002"]) await addFarmer(p, "Bong");
  await addFarmer("0777000003", "Bong", ["rice"]);
  await db.run("UPDATE farmers SET opted_out_at = '2026-01-01 00:00:00' WHERE phone = '+231777000003'");
  const admin = await tokenOf("admin@test.lr");
  const r = await call("POST", "/api/broadcasts", admin, { counties: ["Bong"], channels: ["app"], message: "Rice seed fair in Gbarnga on Saturday." });
  assert.equal(r.status, 201);
  assert.equal(r.body.queued, 0);
  assert.equal(r.body.recipients, 2); // not the farmer who said STOP
  assert.equal(r.body.reach, 2);
  assert.equal(r.body.sms, null);
  assert.equal((await db.get("SELECT COUNT(*) AS n FROM message_log WHERE kind = 'broadcast'")).n, 0);

  const both = await call("POST", "/api/broadcasts", admin, { counties: ["Bong"], channels: ["sms", "app"], message: "Spray only in the evening this week." });
  assert.equal(both.body.queued, 2);
  const voice = await call("POST", "/api/broadcasts", admin, { counties: ["Bong"], channels: ["voice"], message: "Hello" });
  assert.equal(voice.status, 400);
  assert.match(voice.body.details[0], /voice calls are not available yet/);
});

test("a new hotspot is texted to the county's officers (with a phone) and admins, once per level", async () => {
  await armyworm("0880000001", "Nimba");
  const second = await armyworm("0880000002", "Nimba");
  assert.equal(second.hotspot_alert, null);
  const third = await armyworm("0880000003", "Nimba");
  assert.deepEqual(third.hotspot_alert, { level: "Watch", sent_to: 2 });

  const text = "AgriConnect new hotspot: Fall armyworm in Nimba, 3 reports in 7 days. Check the dashboard and warn farmers.";
  assert.deepEqual(await alertsTo("+231886000002"), [text]); // Nimba officer
  assert.deepEqual(await alertsTo("+231886000001"), [text]); // admin
  assert.deepEqual(await alertsTo("+231886000003"), []);     // Bong officer: not their county
  assert.deepEqual(await alertsTo("+231886000004"), []);     // editor: not an officer

  // More reports at the same level: no new SMS. Reaching 5 makes it a Warning: one more SMS.
  await armyworm("0880000004", "Nimba");
  assert.equal((await alertsTo("+231886000002")).length, 1);
  const fifth = await armyworm("0880000005", "Nimba");
  assert.equal(fifth.hotspot_alert.level, "Warning");
  assert.match((await alertsTo("+231886000002"))[1], /^AgriConnect WARNING: Fall armyworm in Nimba, 5 reports/);

  // A switched-off account gets nothing; neither does anyone for a different county.
  await updateStaff(db, (await db.get("SELECT id FROM staff WHERE email = 'nimba@test.lr'")).id, { active: false });
  for (let i = 6; i <= 10; i++) await armyworm(`08800001${String(i).padStart(2, "0")}`, "Nimba");
  assert.equal((await alertsTo("+231886000002")).length, 2);
  assert.equal((await alertsTo("+231886000001")).length, 3); // the admin got the Outbreak alert

  const officer = await tokenOf("bong@test.lr");
  assert.deepEqual((await call("GET", "/api/hotspots/alerts", officer)).body, []); // Bong only
  const all = (await call("GET", "/api/hotspots/alerts", await tokenOf("admin@test.lr"))).body;
  assert.deepEqual(all.map((a) => a.level), ["Outbreak", "Warning", "Watch"]);
});

test("a hotspot nobody could be told about is sent once an officer adds a phone", async () => {
  await db.run("UPDATE staff SET phone = NULL");
  for (const p of ["0880000001", "0880000002", "0880000003"]) await armyworm(p, "Nimba");
  await armyworm("0880000004", "Nimba");
  assert.equal((await db.get("SELECT COUNT(*) AS n FROM hotspot_alerts")).n, 1); // noted once, sent to nobody
  await updateStaff(db, (await db.get("SELECT id FROM staff WHERE email = 'nimba@test.lr'")).id, { phone: "0886000002" });
  const next = await armyworm("0880000005", "Nimba"); // now a Warning (5 reports)
  assert.deepEqual(next.hotspot_alert, { level: "Warning", sent_to: 1 });
  const again = await armyworm("0880000006", "Nimba");
  assert.equal(again.hotspot_alert, null);
});

test("an officer's corrected pest can complete a hotspot and send the alert", async () => {
  await armyworm("0880000001", "Nimba");
  await armyworm("0880000002", "Nimba");
  const other = await createPestReport(db, content, { phone: "0880000003", county: "Nimba", crop: "rice", symptoms: ["spots"], channel: "ussd" });
  assert.equal(await alertsTo("+231886000002").then((a) => a.length), 0);
  await updatePestReport(db, content, other.report.id, { status: "verified", confirmed_pest: "fall-armyworm" });
  assert.equal((await alertsTo("+231886000002")).length, 1);
});

test("staff phones: checked, shown, set by an admin or by the officer themselves", async () => {
  const admin = await tokenOf("admin@test.lr");
  const bad = await call("POST", "/api/staff", admin, { email: "x@test.lr", name: "X", role: "officer", counties: ["Bong"], phone: "12345" });
  assert.equal(bad.status, 400);
  const made = await call("POST", "/api/staff", admin, { email: "x@test.lr", name: "X", role: "officer", counties: ["Bong"], phone: "0777 555 666" });
  assert.equal(made.body.staff.phone, "+231777555666");

  const officer = await tokenOf("bong@test.lr");
  const mine = await call("POST", "/api/staff/me/phone", officer, { phone: "0886 111 222" });
  assert.equal(mine.body.phone, "+231886111222");
  assert.equal((await call("POST", "/api/staff/me/phone", officer, { phone: "" })).body.phone, null);
  assert.equal((await call("POST", "/api/staff/me/phone", officer, { phone: "abc" })).status, 400);
  assert.equal((await call("GET", "/api/staff/me", officer)).body.phone, null);
});

test("alert texts fit in one SMS", () => {
  for (const level of ["Watch", "Warning", "Outbreak"]) {
    const t = hotspotAlertText({ level, pest_name: "Cassava mosaic disease", county: "Grand Cape Mount", reports: 120 });
    assert.ok(t.length <= 160, t);
  }
});
