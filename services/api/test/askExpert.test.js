// Sprint 4: Ask an Expert. Photos and call-backs from the app, routing to an officer, 24-hour escalation.
import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { createApp } from "../src/app.js";
import { createStaff, updateStaff } from "../src/staff.js";
import { cleanFarmerInput, createFarmer } from "../src/farmers.js";
import { createQuestion, escalateOverdue, cleanPhoto, pickOfficer, PHOTO_MAX_BYTES } from "../src/questions.js";
import { sqlDaysAgo } from "../src/db.js";
import { content, newDb } from "./helpers.js";

let db, server, base, clock, ids;
const PW = "correct-horse-battery";
// The smallest real JPEG header + a few bytes: enough for the type check.
const JPEG = "data:image/jpeg;base64," + Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 16, 74, 70, 73, 70, 0, 1, 1, 0, 0, 1, 0, 1, 0, 0, 0xff, 0xd9]).toString("base64");

beforeEach(async () => {
  db = await newDb();
  clock = new Date("2026-06-05T08:00:00Z");
  const app = createApp({ db, content, now: () => clock, staffAuth: true, webhookSecret: "", providerName: "log", rateLimits: false });
  server = await new Promise((ok) => { const s = app.listen(0, () => ok(s)); });
  base = `http://127.0.0.1:${server.address().port}`;
  const make = async (s) => (await createStaff(db, { password: PW, ...s })).staff.id;
  ids = {
    admin: await make({ email: "admin@test.lr", name: "Admin", role: "admin", phone: "0886000001" }),
    salala: await make({ email: "salala@test.lr", name: "Officer Salala", role: "officer", counties: ["Bong"], districts: ["Salala"], phone: "0886000002" }),
    gbarnga: await make({ email: "gbarnga@test.lr", name: "Officer Gbarnga", role: "officer", counties: ["Bong"], districts: "Gbarnga, Suakoko" }),
    nimba: await make({ email: "nimba@test.lr", name: "Officer Nimba", role: "officer", counties: ["Nimba"], phone: "0886000003" })
  };
});
afterEach(async () => { await new Promise((ok) => server.close(ok)); await db.close(); });

async function call(method, path, body, token) {
  const res = await fetch(base + path, {
    method,
    headers: { ...(body ? { "Content-Type": "application/json" } : {}), ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body ? JSON.stringify(body) : undefined
  });
  const type = res.headers.get("content-type") ?? "";
  return { status: res.status, body: type.includes("json") ? await res.json() : Buffer.from(await res.arrayBuffer()), type };
}
const tokenOf = async (email) => (await call("POST", "/api/staff/login", { email, password: PW })).body.token;
const farmer = (phone, county, district) =>
  createFarmer(db, cleanFarmerInput({ phone, county, district, consent: true, channel: "ussd", crops: [{ crop: "rice", planting_month: 5 }] }, content));
async function farmerToken(phone) {
  const { body } = await call("POST", "/api/auth/request-code", { phone });
  return (await call("POST", "/api/auth/verify", { phone, code: body.dev_code })).body.token;
}

test("questions go to the officer for the farmer's district, then to the least busy officer", async () => {
  const salala = await farmer("0777000001", "Bong", "Salala");
  const suakoko = await farmer("0777000002", "Bong", "suakoko"); // any letter case
  const other = await farmer("0777000003", "Bong", "Zota");
  assert.equal((await createQuestion(db, { farmer: salala, body: "a" })).assigned_to, ids.salala);
  assert.equal((await createQuestion(db, { farmer: suakoko, body: "b" })).assigned_to, ids.gbarnga);
  // Zota: nobody covers it, so the officer with fewer open questions gets it. Both have 1: the first.
  assert.equal((await createQuestion(db, { farmer: other, body: "c" })).assigned_to, ids.salala);
  assert.equal((await createQuestion(db, { farmer: other, body: "d" })).assigned_to, ids.gbarnga);
  // No officer for the county, or no county at all: nobody (admins see it).
  assert.equal(await pickOfficer(db, { county: "Lofa" }), null);
  assert.equal((await createQuestion(db, { phone: "+231880000009", body: "e" })).assigned_to, null);
  // A switched-off officer gets nothing new.
  await updateStaff(db, ids.salala, { active: false });
  assert.equal((await createQuestion(db, { farmer: salala, body: "f" })).assigned_to, ids.gbarnga);
});

test("officers see who has each question, filter to their own, and can take one", async () => {
  const f = await farmer("0777000001", "Bong", "Salala");
  const q = await createQuestion(db, { farmer: f, body: "When do I weed?" });
  const gbarnga = await tokenOf("gbarnga@test.lr");
  const all = (await call("GET", "/api/questions", null, gbarnga)).body;
  assert.equal(all[0].assigned_name, "Officer Salala");
  assert.deepEqual((await call("GET", "/api/questions?mine=1", null, gbarnga)).body, []);

  const took = await call("PATCH", `/api/questions/${q.id}/assign`, { staff_id: "me" }, gbarnga);
  assert.equal(took.status, 200);
  assert.equal(took.body.assigned_name, "Officer Gbarnga");
  assert.equal((await call("GET", "/api/questions?mine=1", null, gbarnga)).body.length, 1);
  // Officers can't hand questions to others, or take questions outside their counties.
  assert.equal((await call("PATCH", `/api/questions/${q.id}/assign`, { staff_id: ids.salala }, gbarnga)).status, 403);
  assert.equal((await call("PATCH", `/api/questions/${q.id}/assign`, { staff_id: "me" }, await tokenOf("nimba@test.lr"))).status, 403);
  // Admins can hand it to an officer who covers the county, not to anyone else.
  const admin = await tokenOf("admin@test.lr");
  assert.equal((await call("PATCH", `/api/questions/${q.id}/assign`, { staff_id: ids.salala }, admin)).body.assigned_to, ids.salala);
  assert.equal((await call("PATCH", `/api/questions/${q.id}/assign`, { staff_id: ids.nimba }, admin)).status, 400);
  assert.equal((await db.get("SELECT COUNT(*) AS n FROM audit_log WHERE action = 'question.assign'")).n, 2);
});

test("from the app: a question with a photo, and a call-back request; offline retries don't duplicate", async () => {
  const token = await farmerToken("0777000001");
  await call("POST", "/api/me/register", { name: "Kollie", county: "Bong", district: "Salala", consent: true, crops: [{ crop: "rice", planting_month: 5 }] }, token);

  const sent = await call("POST", "/api/me/questions", { body: "What is eating my rice?", photo: JPEG, client_id: "photo-question-1" }, token);
  assert.equal(sent.status, 201);
  assert.equal(sent.body.question.kind, "photo");
  assert.equal(sent.body.question.has_photo, true);
  assert.equal(sent.body.question.assigned_to, ids.salala);
  assert.equal((await call("POST", "/api/me/questions", { body: "What is eating my rice?", photo: JPEG, client_id: "photo-question-1" }, token)).body.duplicate, true);
  const onlyPhoto = await call("POST", "/api/me/questions", { photo: JPEG, client_id: "photo-only-1" }, token);
  assert.equal(onlyPhoto.status, 201);
  assert.equal(onlyPhoto.body.question.body, null);

  const cb = await call("POST", "/api/me/questions", { kind: "callback", client_id: "callback-1" }, token);
  assert.equal(cb.body.question.kind, "callback");
  assert.equal((await call("POST", "/api/me/questions", { client_id: "empty-1" }, token)).status, 400);

  const home = (await call("GET", "/api/me/home", null, token)).body;
  assert.equal(home.questions.filter((q) => q.has_photo).length, 2);

  // The officer sees the photo; officers from other counties don't.
  const officer = await tokenOf("salala@test.lr");
  const photo = await call("GET", `/api/questions/${sent.body.question.id}/photo`, null, officer);
  assert.equal(photo.status, 200);
  assert.equal(photo.type, "image/jpeg");
  assert.equal(photo.body[0], 0xff);
  assert.equal((await call("GET", `/api/questions/${sent.body.question.id}/photo`, null, await tokenOf("nimba@test.lr"))).status, 403);
  assert.equal((await call("GET", `/api/questions/${cb.body.question.id}/photo`, null, officer)).status, 404);
});

test("photos are checked: real pictures only, not too big", async () => {
  assert.equal(cleanPhoto(JPEG).mime, "image/jpeg");
  assert.throws(() => cleanPhoto("data:image/gif;base64,R0lGOD"), /JPEG, PNG or WebP/);
  assert.throws(() => cleanPhoto("data:image/jpeg;base64," + Buffer.from("<script>alert(1)</script>").toString("base64")), /not a real picture/);
  const big = Buffer.alloc(PHOTO_MAX_BYTES + 10); big[0] = 0xff; big[1] = 0xd8; big[2] = 0xff;
  assert.throws(() => cleanPhoto("data:image/jpeg;base64," + big.toString("base64")), /too big/);

  // Over HTTP, a photo too big for the request is refused cleanly.
  const token = await farmerToken("0777000001");
  await call("POST", "/api/me/register", { county: "Bong", consent: true, crops: [{ crop: "rice", planting_month: 5 }] }, token);
  const r = await call("POST", "/api/me/questions", { photo: "data:image/jpeg;base64," + big.toString("base64") }, token);
  assert.equal(r.status, 400);
});

test("after 24 hours unanswered, a question is escalated once: officers and admins are texted, the farmer is reassured", async () => {
  const f = await farmer("0777000001", "Bong", "Salala");
  const old = await createQuestion(db, { farmer: f, body: "My cassava leaves are yellow" });
  const fresh = await createQuestion(db, { farmer: f, body: "Second question" });
  const answered = await createQuestion(db, { farmer: f, body: "Third" });
  await db.run("UPDATE questions SET created_at = ? WHERE id IN (?, ?)", sqlDaysAgo(1.1, clock), old.id, answered.id);
  await db.run("UPDATE questions SET status = 'answered' WHERE id = ?", answered.id);
  const ctx = { db, content, now: () => clock };

  assert.deepEqual(await escalateOverdue(ctx), { escalated: 1 });
  assert.equal((await db.get("SELECT status FROM questions WHERE id = ?", old.id)).status, "escalated");
  assert.equal((await db.get("SELECT status FROM questions WHERE id = ?", fresh.id)).status, "open");
  const sms = async (phone) => (await db.all("SELECT body FROM message_log WHERE phone = ? ORDER BY id", phone)).map((m) => m.body);
  assert.match((await sms("+231886000002"))[0], new RegExp(`Q-${old.id} from Bong has waited over 24h \\(Officer Salala\\)`));
  assert.equal((await sms("+231886000001")).length, 1); // admin
  assert.equal((await sms("+231886000003")).length, 0); // Nimba officer
  assert.match((await sms("+231777000001")).at(-1), /we have not forgotten your question/);
  assert.deepEqual(await escalateOverdue(ctx), { escalated: 0 }); // never twice

  // Overdue questions come first, still count as open, and can be answered as usual.
  const officer = await tokenOf("salala@test.lr");
  const list = (await call("GET", "/api/questions?status=open", null, officer)).body;
  assert.deepEqual(list.map((q) => q.id), [old.id, fresh.id]);
  const ans = await call("PATCH", `/api/questions/${old.id}`, { answer: "Add compost and check for mosaic." }, officer);
  assert.equal(ans.body.question.status, "answered");
  // The farmer app shows "With officer" rather than "escalated".
  const token = await farmerToken("0777000001");
  const home = (await call("GET", "/api/me/home", null, token)).body;
  assert.ok(home.questions.every((q) => q.status !== "escalated"));
});

test("staff districts are cleaned and shown", async () => {
  const admin = await tokenOf("admin@test.lr");
  const list = (await call("GET", "/api/staff", null, admin)).body;
  assert.deepEqual(list.find((s) => s.email === "gbarnga@test.lr").districts, ["Gbarnga", "Suakoko"]);
  const r = await call("PATCH", `/api/staff/${ids.nimba}`, { districts: [" Ganta ", "Ganta", "", "Saclepea"] }, admin);
  assert.deepEqual(r.body.districts, ["Ganta", "Saclepea"]);
});
