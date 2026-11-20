import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { startTestServer, kollie } from "./helpers.js";

let api;
before(async () => { api = await startTestServer({ now: () => new Date("2026-06-05T08:00:00Z") }); });
after(() => api.close());

test("health check", async () => {
  const { status, body } = await api.call("GET", "/health");
  assert.equal(status, 200);
  assert.equal(body.ok, true);
});

test("lists Liberia's 15 counties", async () => {
  const { body } = await api.call("GET", "/api/counties");
  assert.equal(body.length, 15);
});

test("registers a farmer and normalises the phone number", async () => {
  const { status, body } = await api.call("POST", "/api/farmers", kollie);
  assert.equal(status, 201);
  assert.equal(body.phone, "+231777123456");
  assert.equal(body.county, "Bong");
  assert.equal(body.crops.length, 2);
  assert.ok(body.consent_at);
});

test("refuses a second registration with the same phone", async () => {
  const { status } = await api.call("POST", "/api/farmers", { ...kollie, phone: "+231777123456" });
  assert.equal(status, 409);
});

test("refuses registration without consent, with a clear list of problems", async () => {
  const { status, body } = await api.call("POST", "/api/farmers", { phone: "123", county: "Atlantis", crops: [] });
  assert.equal(status, 400);
  assert.ok(body.details.some((d) => d.startsWith("phone")));
  assert.ok(body.details.some((d) => d.startsWith("county")));
  assert.ok(body.details.some((d) => d.startsWith("consent")));
  assert.ok(body.details.some((d) => d.startsWith("crops")));
});

test("rejects broken JSON with a 400", async () => {
  const res = await fetch(api.base + "/api/farmers", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{not json" });
  assert.equal(res.status, 400);
  assert.equal((await res.json()).error, "Body must be valid JSON");
});

test("this week's advice for a registered farmer", async () => {
  const { body: list } = await api.call("GET", "/api/farmers?county=bong");
  const { status, body } = await api.call("GET", `/api/farmers/${list[0].id}/advice`);
  assert.equal(status, 200);
  assert.equal(body.advice.find((a) => a.crop === "rice").stage, "first-weeding");
});

test("pest report from a registered farmer gets a diagnosis and an SMS reply", async () => {
  const { status, body } = await api.call("POST", "/api/pest-reports", {
    phone: "0777123456", crop: "rice", symptoms: ["holes", "caterpillar"], channel: "ussd"
  });
  assert.equal(status, 201);
  assert.equal(body.diagnosis.pest, "fall-armyworm");
  assert.equal(body.report.county, "Bong");
  assert.match(body.reply_sms, /FALL ARMYWORM/);
  assert.match(body.reply_sms, /Ref PR-\d+/);
  assert.ok(body.reply_sms.length <= 160);
});

test("pest report from an unregistered farmer needs a county", async () => {
  const missing = await api.call("POST", "/api/pest-reports", { phone: "0880000000", symptoms: ["rot"] });
  assert.equal(missing.status, 400);
  const ok = await api.call("POST", "/api/pest-reports", { phone: "0880000000", county: "Nimba", symptoms: ["rot", "brown"] });
  assert.equal(ok.status, 201);
  assert.equal(ok.body.diagnosis.pest, "cocoa-black-pod");
});

test("officer can list new pest reports for a county", async () => {
  const { body } = await api.call("GET", "/api/pest-reports?county=Bong&status=new");
  assert.equal(body.length, 1);
  assert.deepEqual(body[0].symptoms, ["holes", "caterpillar"]);
});

test("stats count farmers by county", async () => {
  const { body } = await api.call("GET", "/api/stats");
  assert.equal(body.farmers, 1);
  assert.equal(body.pest_reports_7d >= 0, true);
  assert.deepEqual(body.by_county, [{ county: "Bong", farmers: 1 }]);
});

test("unknown routes return 404 JSON", async () => {
  const { status } = await api.call("GET", "/api/nothing-here");
  assert.equal(status, 404);
});
