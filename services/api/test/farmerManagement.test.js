// Sprint 2.2: officers search their farmers, read one farmer's history, correct details, export a CSV.
import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { createApp } from "../src/app.js";
import { createStaff } from "../src/staff.js";
import { cleanFarmerInput, createFarmer, csvCell } from "../src/farmers.js";
import { content, newDb } from "./helpers.js";

let server, base, db;
const PW = "correct-horse-battery";
beforeEach(async () => {
  db = await newDb();
  const app = createApp({ db, content, now: () => new Date("2026-06-05T08:00:00Z"), staffAuth: true, webhookSecret: "", providerName: "log", rateLimits: false });
  server = await new Promise((ok) => { const s = app.listen(0, () => ok(s)); });
  base = `http://127.0.0.1:${server.address().port}`;
  await createStaff(db, { email: "admin@test.lr", name: "Admin", role: "admin", password: PW });
  await createStaff(db, { email: "mulbah@test.lr", name: "Officer Mulbah", role: "officer", counties: ["Bong"], password: PW });
  await createStaff(db, { email: "viewer@test.lr", name: "Viewer", role: "viewer", password: PW });
  await createStaff(db, { email: "lead@test.lr", name: "Lead", role: "lead", counties: ["Bong"], password: PW });
  const add = (f) => createFarmer(db, cleanFarmerInput({ consent: true, channel: "ussd", ...f }, content));
  await add({ phone: "0777123456", name: "Kollie Mulbah", county: "Bong", district: "Salala", crops: [{ crop: "rice", planting_month: 5 }] });
  await add({ phone: "0777000222", name: "Fatu Kollie", county: "Bong", district: "Gbarnga", crops: [{ crop: "cassava", planting_month: 4 }] });
  await add({ phone: "0888000333", name: "=HYPERLINK(\"http://evil\")", county: "Nimba", district: "Ganta", crops: [{ crop: "rice", planting_month: 6 }] });
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
  return { status: res.status, body: json, headers: res.headers };
}
const tokenOf = async (email) => (await call("POST", "/api/staff/login", { email, password: PW })).body.token;
const idOf = async (phone) => (await db.get("SELECT id FROM farmers WHERE phone = ?", phone)).id;

test("search by name, district or the phone digits people type; officers only find their counties", async () => {
  const officer = await tokenOf("mulbah@test.lr");
  const admin = await tokenOf("admin@test.lr");
  const names = async (qs, t = officer) => (await call("GET", `/api/farmers?${qs}`, null, t)).body.map((f) => f.name).sort();

  assert.deepEqual(await names("q=kollie"), ["Fatu Kollie", "Kollie Mulbah"]); // any case, first or last name
  assert.deepEqual(await names("q=GBARNGA"), ["Fatu Kollie"]);
  assert.deepEqual(await names("q=0777 123"), ["Kollie Mulbah"]);
  assert.deepEqual(await names("q=%2B231777000"), ["Fatu Kollie"]);
  assert.deepEqual(await names("q=100%25"), []); // % is a letter here, not "anything"
  assert.deepEqual(await names("crop=cassava"), ["Fatu Kollie"]);
  assert.deepEqual(await names("q=ganta"), []); // Nimba is outside Mulbah's area
  assert.deepEqual(await names("q=ganta", admin), ['=HYPERLINK("http://evil")']);

  const all = await call("GET", "/api/farmers?limit=1", null, officer);
  assert.equal(all.body.length, 1);
  assert.equal(all.headers.get("x-total-count"), "2");
  assert.equal((await call("GET", "/api/farmers?county=Nimba", null, officer)).status, 403);
  assert.equal((await call("GET", "/api/farmers?crop=banana", null, officer)).status, 400);
  assert.equal((await call("GET", "/api/farmers?status=gone", null, officer)).status, 400);

  await db.run("UPDATE farmers SET opted_out_at = '2026-06-01 10:00:00' WHERE phone = '+231777000222'");
  assert.deepEqual(await names("status=opted_out"), ["Fatu Kollie"]);
  assert.deepEqual(await names("status=active"), ["Kollie Mulbah"]);
});

test("one farmer's history shows messages, pest reports, questions and sign-up, newest first", async () => {
  const officer = await tokenOf("mulbah@test.lr");
  await call("POST", "/sms/inbound", { from: "0777123456", text: "ASK my rice leaves are yellow" });
  await call("POST", "/ussd", { phoneNumber: "0777123456", text: "4*1*1*2" }); // report a pest
  const id = await idOf("+231777123456");

  const { status, body } = await call("GET", `/api/farmers/${id}/history`, null, officer);
  assert.equal(status, 200);
  assert.equal(body.farmer.name, "Kollie Mulbah");
  assert.equal(body.summary.questions, 1);
  assert.ok(body.summary.messages_in >= 1);
  assert.ok(body.summary.sms_out >= 1);
  const types = body.timeline.map((e) => e.type);
  assert.ok(types.includes("question") && types.includes("message"));
  assert.equal(types.at(-1), "joined"); // the oldest thing
  const times = body.timeline.map((e) => e.at);
  assert.deepEqual(times, [...times].sort().reverse());

  // Not the officer's county, or not allowed to see farmers at all.
  assert.equal((await call("GET", `/api/farmers/${await idOf("+231888000333")}/history`, null, officer)).status, 403);
  assert.equal((await call("GET", `/api/farmers/${id}/history`, null, await tokenOf("viewer@test.lr"))).status, 403);
  assert.equal((await call("GET", `/api/farmers/99999/history`, null, officer)).status, 404);
});

test("an officer corrects crops, planting month and name; the change is audited", async () => {
  const officer = await tokenOf("mulbah@test.lr");
  const id = await idOf("+231777123456");
  const { status, body } = await call("PATCH", `/api/farmers/${id}`, {
    name: "Kollie M. Mulbah", crops: [{ crop: "rice", planting_month: 6 }, { crop: "cassava", planting_month: 3 }]
  }, officer);
  assert.equal(status, 200);
  assert.equal(body.name, "Kollie M. Mulbah");
  assert.deepEqual(body.crops, [{ crop: "cassava", planting_month: 3 }, { crop: "rice", planting_month: 6 }]);
  assert.deepEqual(body.changes.crops, ["rice:5", "cassava:3,rice:6"]);
  assert.equal(body.district, "Salala"); // untouched fields stay
  const log = await db.get("SELECT * FROM audit_log WHERE action = 'farmer.update'");
  assert.equal(log.staff_email, "mulbah@test.lr");
  assert.match(log.detail, /Kollie M\. Mulbah/);

  // Saving the same thing again changes nothing and logs nothing.
  const again = await call("PATCH", `/api/farmers/${id}`, { name: "Kollie M. Mulbah" }, officer);
  assert.deepEqual(again.body.changes, {});
  assert.equal((await db.get("SELECT COUNT(*) AS n FROM audit_log WHERE action = 'farmer.update'")).n, 1);
});

test("edits are checked: no bad crops, no phone or consent changes, no moving farmers out of the officer's area", async () => {
  const officer = await tokenOf("mulbah@test.lr");
  const id = await idOf("+231777123456");
  const bad = async (patch) => (await call("PATCH", `/api/farmers/${id}`, patch, officer)).status;
  assert.equal(await bad({ crops: [] }), 400);
  assert.equal(await bad({ crops: [{ crop: "rice", planting_month: 13 }] }), 400);
  assert.equal(await bad({ phone: "0777999999" }), 400);
  assert.equal(await bad({ opted_out_at: null }), 400);
  assert.equal(await bad({ language: "fr" }), 400);
  assert.equal(await bad({ county: "Nimba" }), 403);
  assert.equal((await call("PATCH", `/api/farmers/${await idOf("+231888000333")}`, { name: "X" }, officer)).status, 403);
  assert.equal((await call("PATCH", `/api/farmers/${id}`, { name: "X" }, await tokenOf("lead@test.lr"))).status, 403);
  assert.equal((await call("PATCH", `/api/farmers/${id}`, { name: "X" }, await tokenOf("viewer@test.lr"))).status, 403);
  // An admin can move a farmer to another county.
  const moved = await call("PATCH", `/api/farmers/${id}`, { county: "nimba", district: "" }, await tokenOf("admin@test.lr"));
  assert.equal(moved.body.county, "Nimba");
  assert.equal(moved.body.district, null);
});

test("CSV export: officer's counties only, counts per farmer, safe from spreadsheet formulas, audited", async () => {
  await call("POST", "/sms/inbound", { from: "0777123456", text: "ASK when to weed?" });
  const officer = await tokenOf("mulbah@test.lr");
  const res = await fetch(base + "/api/farmers/export.csv", { headers: { Authorization: `Bearer ${officer}` } });
  assert.equal(res.status, 200);
  assert.match(res.headers.get("content-type"), /text\/csv/);
  assert.match(res.headers.get("content-disposition"), /agriconnect-farmers-2026-06-05\.csv/);
  const buf = Buffer.from(await res.arrayBuffer());
  assert.deepEqual([...buf.subarray(0, 3)], [0xef, 0xbb, 0xbf]); // UTF-8 byte-order mark for Excel
  const text = buf.toString("utf8").slice(1);
  const lines = text.trim().split("\r\n");
  const head = lines[0].split(",");
  assert.equal(lines.length, 3); // header + 2 Bong farmers
  const kollie = Object.fromEntries(lines.find((l) => l.includes("Kollie Mulbah")).split(",").map((v, i) => [head[i], v]));
  assert.equal(kollie.phone, "'+231777123456");
  assert.equal(kollie.crops, "rice (May)");
  assert.equal(kollie.questions, "1");
  assert.equal(kollie.messages_in, "1");
  assert.ok(kollie.last_contact_at);
  assert.ok(!text.includes("Ganta"));
  assert.equal((await db.get("SELECT COUNT(*) AS n FROM audit_log WHERE action = 'farmers.export'")).n, 1);

  const adminCsv = await (await fetch(base + "/api/farmers/export.csv", { headers: { Authorization: `Bearer ${await tokenOf("admin@test.lr")}` } })).text();
  assert.ok(adminCsv.includes(`"'=HYPERLINK(""http://evil"")"`)); // stays text in Excel

  const viewer = await fetch(base + "/api/farmers/export.csv", { headers: { Authorization: `Bearer ${await tokenOf("viewer@test.lr")}` } });
  assert.equal(viewer.status, 403);
});

test("csvCell quotes commas and quotes and defuses formulas", () => {
  assert.equal(csvCell("Salala, Bong"), '"Salala, Bong"');
  assert.equal(csvCell('say "hi"'), '"say ""hi"""');
  assert.equal(csvCell("@SUM(A1)"), "'@SUM(A1)");
  assert.equal(csvCell("-2"), "'-2");
  assert.equal(csvCell(null), "");
  assert.equal(csvCell(12), "12");
});
