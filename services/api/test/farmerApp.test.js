import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { createApp } from "../src/app.js";
import { openDb } from "../src/db.js";
import { content } from "./helpers.js";

let server, base, db, clock;
const PHONE = "0777 123 999";

async function start({ providerName = "log" } = {}) {
  db = openDb(":memory:");
  clock = new Date("2026-06-05T08:00:00Z");
  const app = createApp({ db, content, now: () => clock, staffAuth: false, webhookSecret: "", providerName });
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

async function signIn(phone = PHONE) {
  const { body } = await call("POST", "/api/auth/request-code", { phone });
  const v = await call("POST", "/api/auth/verify", { phone, code: body.dev_code });
  assert.equal(v.status, 200);
  return v.body;
}

const REG = { name: "Kollie", county: "Bong", district: "Salala", language: "en", consent: true, crops: [{ crop: "rice", planting_month: 5 }] };

test("sign in with an SMS code; the code is sent by SMS", async () => {
  const r = await call("POST", "/api/auth/request-code", { phone: PHONE });
  assert.equal(r.status, 200);
  assert.match(r.body.dev_code, /^\d{6}$/);
  const sms = db.prepare("SELECT body FROM message_log WHERE phone = '+231777123999'").get();
  assert.match(sms.body, new RegExp(`code is ${r.body.dev_code}`));
  const v = await call("POST", "/api/auth/verify", { phone: PHONE, code: r.body.dev_code });
  assert.equal(v.body.registered, false);
  assert.ok(v.body.token.length > 30);
});

test("the code is never shown when a real SMS provider is used", async () => {
  await new Promise((ok) => server.close(ok));
  await start({ providerName: "africastalking" });
  const r = await call("POST", "/api/auth/request-code", { phone: PHONE });
  assert.equal(r.body.dev_code, undefined);
});

test("wrong codes, reused codes, expired codes and too many requests are refused", async () => {
  const { body } = await call("POST", "/api/auth/request-code", { phone: PHONE });
  const wrong = body.dev_code === "000000" ? "111111" : "000000";
  assert.equal((await call("POST", "/api/auth/verify", { phone: PHONE, code: wrong })).status, 400);
  assert.equal((await call("POST", "/api/auth/verify", { phone: PHONE, code: body.dev_code })).status, 200);
  assert.equal((await call("POST", "/api/auth/verify", { phone: PHONE, code: body.dev_code })).status, 400, "a code works once");

  const second = (await call("POST", "/api/auth/request-code", { phone: PHONE })).body.dev_code;
  clock = new Date(clock.getTime() + 11 * 60 * 1000);
  assert.equal((await call("POST", "/api/auth/verify", { phone: PHONE, code: second })).status, 400, "expired after 10 minutes");

  for (let i = 0; i < 3; i++) await call("POST", "/api/auth/request-code", { phone: "0777000555" });
  assert.equal((await call("POST", "/api/auth/request-code", { phone: "0777000555" })).status, 429);
});

test("five wrong guesses lock the code", async () => {
  const { body } = await call("POST", "/api/auth/request-code", { phone: PHONE });
  const wrong = body.dev_code === "000000" ? "111111" : "000000";
  for (let i = 0; i < 5; i++) await call("POST", "/api/auth/verify", { phone: PHONE, code: wrong });
  const r = await call("POST", "/api/auth/verify", { phone: PHONE, code: body.dev_code });
  assert.equal(r.status, 400);
  assert.match(r.body.error, /Too many wrong codes/);
});

test("farmer routes need a valid session", async () => {
  assert.equal((await call("GET", "/api/me")).status, 401);
  assert.equal((await call("GET", "/api/me", null, "made-up-token")).status, 401);
});

test("register in the app, then load home with this week's advice", async () => {
  const { token } = await signIn();
  assert.equal((await call("GET", "/api/me/home", null, token)).status, 403, "must register first");
  const reg = await call("POST", "/api/me/register", REG, token);
  assert.equal(reg.status, 201);
  assert.equal(reg.body.farmer.phone, "+231777123999");
  assert.equal(reg.body.farmer.channel, "app");
  assert.equal((await call("POST", "/api/me/register", REG, token)).status, 409);

  const home = await call("GET", "/api/me/home", null, token);
  assert.equal(home.body.farmer.county, "Bong");
  assert.equal(home.body.advice[0].stage, "first-weeding");
  // welcome + first advice + sign-in code were sent by SMS
  const kinds = db.prepare("SELECT kind FROM message_log WHERE phone = '+231777123999' ORDER BY id").all().map((r) => r.kind);
  assert.deepEqual(kinds, ["alert", "welcome", "advice"]);
});

test("a pest report from the app gets a diagnosis, and a retried sync does not duplicate it", async () => {
  const { token } = await signIn();
  await call("POST", "/api/me/register", REG, token);
  const report = { crop: "rice", symptoms: ["holes", "caterpillar"], client_id: "offline-abc-123" };
  const first = await call("POST", "/api/me/reports", report, token);
  assert.equal(first.status, 201);
  assert.equal(first.body.diagnosis.pest, "fall-armyworm");
  assert.equal(first.body.report.channel, "app");
  const again = await call("POST", "/api/me/reports", report, token);
  assert.equal(again.status, 200);
  assert.equal(again.body.duplicate, true);
  assert.equal(again.body.report.id, first.body.report.id);
  const home = await call("GET", "/api/me/home", null, token);
  assert.equal(home.body.reports.length, 1);
});

test("questions from the app reach the officer, and the answer shows in the app", async () => {
  const { token } = await signIn();
  await call("POST", "/api/me/register", REG, token);
  const q = await call("POST", "/api/me/questions", { body: "When do I harvest?", client_id: "offline-q-0001" }, token);
  assert.equal(q.status, 201);
  assert.equal((await call("POST", "/api/me/questions", { body: "When do I harvest?", client_id: "offline-q-0001" }, token)).body.duplicate, true);
  const answer = await call("PATCH", `/api/questions/${q.body.question.id}`, { answer: "When most grains are golden." }, "officer-secret");
  assert.equal(answer.status, 200);
  const home = await call("GET", "/api/me/home", null, token);
  assert.equal(home.body.questions[0].answer, "When most grains are golden.");
});

test("home shows hotspots and advisories for the farmer's county and crops only", async () => {
  const { token } = await signIn();
  await call("POST", "/api/me/register", REG, token);
  for (const p of ["0880000001", "0880000002", "0880000003"])
    await call("POST", "/api/pest-reports", { phone: p, county: "Bong", crop: "rice", symptoms: ["holes", "caterpillar"] }, "officer-secret");
  await call("POST", "/api/broadcasts", { counties: ["Bong"], crops: ["rice"], message: "Rice farmers in Bong: check for armyworm." }, "officer-secret");
  await call("POST", "/api/broadcasts", { counties: ["Lofa"], message: "Only for Lofa." }, "officer-secret");
  await call("POST", "/api/broadcasts", { crops: ["cassava"], message: "Only for cassava." }, "officer-secret");
  const { alerts } = (await call("GET", "/api/me/home", null, token)).body;
  assert.equal(alerts.hotspots.length, 1);
  assert.equal(alerts.hotspots[0].pest_name, "Fall armyworm");
  assert.deepEqual(alerts.broadcasts.map((b) => b.message), ["Rice farmers in Bong: check for armyworm."]);
});

test("profile: change language, stop SMS, sign out", async () => {
  const { token } = await signIn();
  await call("POST", "/api/me/register", REG, token);
  const r = await call("PATCH", "/api/me", { language: "kpe", sms: false }, token);
  assert.equal(r.body.farmer.language, "kpe");
  assert.ok(r.body.farmer.opted_out_at);
  await call("POST", "/api/auth/logout", {}, token);
  assert.equal((await call("GET", "/api/me", null, token)).status, 401);
});

test("the farmer app and the shared engine are served", async () => {
  const page = await fetch(base + "/app/");
  assert.equal(page.status, 200);
  assert.match(await page.text(), /AgriConnect/);
  const engine = await fetch(base + "/app/engine.js");
  assert.match(engine.headers.get("content-type"), /javascript/);
  assert.match(await engine.text(), /export function diagnose/);
});
