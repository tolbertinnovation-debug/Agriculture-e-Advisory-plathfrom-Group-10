import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { startTestServer } from "./helpers.js";

let api;
beforeEach(async () => { api = await startTestServer(); });
afterEach(() => api.close());

const farmer = (phone, county, crops = ["rice"]) =>
  api.call("POST", "/api/farmers", { phone, county, consent: true, crops: crops.map((crop) => ({ crop, planting_month: 5 })) });
const report = (phone, county, symptoms = ["holes", "caterpillar"], crop = "rice") =>
  api.call("POST", "/api/pest-reports", { phone, county, crop, symptoms, channel: "ussd" });
// Messages sent TO this phone, newest first.
const inbox = async (phone) =>
  (await api.call("GET", `/api/messages?phone=${encodeURIComponent(phone)}`)).body.filter((m) => m.direction === "out").map((m) => m.body);

test("3 reports of the same pest in one county make a hotspot; 2 do not", async () => {
  await report("0880000001", "Nimba");
  await report("0880000002", "Nimba");
  assert.deepEqual((await api.call("GET", "/api/hotspots")).body, []);
  await report("0880000003", "Nimba");
  await report("0880000004", "Bong"); // different county: not part of the Nimba hotspot
  const { body } = await api.call("GET", "/api/hotspots");
  assert.equal(body.length, 1);
  assert.equal(body[0].pest, "fall-armyworm");
  assert.equal(body[0].pest_name, "Fall armyworm");
  assert.equal(body[0].county, "Nimba");
  assert.equal(body[0].reports, 3);
  assert.equal(body[0].level, "Watch");
});

test("rejected reports do not count towards a hotspot", async () => {
  for (const p of ["0880000001", "0880000002", "0880000003"]) await report(p, "Lofa");
  const [first] = (await api.call("GET", "/api/pest-reports")).body;
  await api.call("PATCH", `/api/pest-reports/${first.id}`, { status: "rejected" });
  assert.deepEqual((await api.call("GET", "/api/hotspots")).body, []);
});

test("verifying a report (with a corrected pest) notifies the farmer once", async () => {
  await farmer("0777100100", "Bong", ["rice"]);
  const created = (await report("0777100100", null, ["spots"], "rice")).body;
  const r = await api.call("PATCH", `/api/pest-reports/${created.report.id}`, { status: "verified", confirmed_pest: "rice-blast" });
  assert.equal(r.status, 200);
  assert.equal(r.body.notified, true);
  assert.equal(r.body.report.confirmed_pest, "rice-blast");
  assert.match((await inbox("0777100100"))[0], /confirmed RICE BLAST/);
  const again = await api.call("PATCH", `/api/pest-reports/${created.report.id}`, { status: "verified" });
  assert.equal(again.body.notified, false);
});

test("bad report updates are refused", async () => {
  const created = (await report("0880000001", "Bong")).body;
  assert.equal((await api.call("PATCH", `/api/pest-reports/${created.report.id}`, { status: "maybe" })).status, 400);
  assert.equal((await api.call("PATCH", `/api/pest-reports/${created.report.id}`, { confirmed_pest: "dragons" })).status, 400);
  assert.equal((await api.call("PATCH", "/api/pest-reports/999", { status: "closed" })).status, 404);
});

test("answering a question sends the answer to the farmer by SMS", async () => {
  await farmer("0777200200", "Lofa");
  await api.call("POST", "/sms/inbound", { from: "0777200200", text: "ASK when do I harvest rice" });
  const [q] = (await api.call("GET", "/api/questions?status=open")).body;
  const tooLong = await api.call("PATCH", `/api/questions/${q.id}`, { answer: "x".repeat(200) });
  assert.equal(tooLong.status, 400);
  const r = await api.call("PATCH", `/api/questions/${q.id}`, { answer: "Harvest when most grains are golden.", answered_by: "Officer Mulbah" });
  assert.equal(r.body.question.status, "answered");
  assert.equal(r.body.notified, true);
  assert.equal((await inbox("0777200200"))[0], "AgriConnect officer: Harvest when most grains are golden.");
});

test("a call-back request can be closed without an SMS", async () => {
  await farmer("0777300300", "Nimba");
  await fetch(api.base + "/ussd", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ phoneNumber: "0777300300", text: "5*1" }) });
  const [q] = (await api.call("GET", "/api/questions")).body;
  assert.equal(q.kind, "callback");
  const r = await api.call("PATCH", `/api/questions/${q.id}`, {});
  assert.equal(r.body.question.status, "answered");
  assert.equal(r.body.notified, false);
});

test("broadcast reaches only matching farmers who have not said STOP", async () => {
  await farmer("0777000001", "Nimba", ["rice"]);
  await farmer("0777000002", "Nimba", ["cassava"]);
  await farmer("0777000003", "Bong", ["rice"]);
  await farmer("0777000004", "Nimba", ["rice", "cassava"]);
  await api.call("POST", "/sms/inbound", { from: "0777000004", text: "STOP" });

  const target = { counties: ["Nimba"], crops: ["rice"] };
  assert.equal((await api.call("POST", "/api/broadcasts/preview", target)).body.reach, 1);
  assert.equal((await api.call("POST", "/api/broadcasts/preview", { counties: ["Nimba"] })).body.reach, 2);
  assert.equal((await api.call("POST", "/api/broadcasts/preview", {})).body.reach, 3);

  const msg = "Fall armyworm seen in Nimba. Check your fields this week. Dial *347# option 4 to report.";
  const sent = await api.call("POST", "/api/broadcasts", { ...target, message: msg, sent_by: "Officer Mulbah" });
  assert.equal(sent.status, 201);
  assert.equal(sent.body.queued, 1);
  assert.equal((await inbox("0777000001"))[0], msg);
  assert.equal((await inbox("0777000002")).length, 0); // cassava only: not targeted
  assert.equal((await inbox("0777000004")).length, 1); // only the STOP confirmation, not the broadcast
});

test("broadcast input is checked", async () => {
  assert.equal((await api.call("POST", "/api/broadcasts", { message: "" })).status, 400);
  assert.equal((await api.call("POST", "/api/broadcasts", { message: "x".repeat(161) })).status, 400);
  assert.equal((await api.call("POST", "/api/broadcasts", { counties: ["Atlantis"], message: "hi" })).status, 400);
});

test("stats include hotspots and reports waiting for an officer", async () => {
  for (const p of ["0880000001", "0880000002", "0880000003"]) await report(p, "Nimba");
  const { body } = await api.call("GET", "/api/stats");
  assert.equal(body.hotspots, 1);
  assert.equal(body.counties_flagged, 1);
  assert.equal(body.reports_to_check, 3);
});

test("with OFFICER_TOKEN set, officer routes need the token; farmer routes stay open", async () => {
  const secure = await startTestServer({ officerToken: "s3cret" });
  try {
    assert.equal((await secure.call("GET", "/api/stats")).status, 401);
    assert.equal((await secure.call("GET", "/api/stats", null, { Authorization: "Bearer wrong" })).status, 401);
    assert.equal((await secure.call("GET", "/api/stats", null, { Authorization: "Bearer s3cret" })).status, 200);
    assert.equal((await secure.call("POST", "/api/broadcasts", { message: "hi" })).status, 401);
    assert.equal((await secure.call("GET", "/api/counties")).status, 200);
    assert.equal((await secure.call("POST", "/api/pest-reports", { phone: "0880000001", county: "Bong", symptoms: ["rot"] })).status, 401);
    assert.equal((await secure.call("POST", "/api/auth/request-code", { phone: "0880000001" })).status, 200);
  } finally {
    await secure.close();
  }
});
