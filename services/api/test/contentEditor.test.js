// Sprint 5: content editor (editors draft, agronomists approve) and the rain override.
import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { createApp } from "../src/app.js";
import { createStaff } from "../src/staff.js";
import { cleanFarmerInput, createFarmer, getFarmer } from "../src/farmers.js";
import { adviceForFarmer } from "../src/engine.js";
import { applyApprovedTexts, restoreFileTexts, listContent } from "../src/contentEditor.js";
import { sendAdviceToFarmer } from "../src/scheduler.js";
import { createPestReport } from "../src/pestReports.js";
import { content, newDb } from "./helpers.js";

let db, server, base;
const PW = "correct-horse-battery";
const NOW = new Date("2026-06-05T08:00:00Z");
beforeEach(async () => {
  db = await newDb();
  const app = createApp({ db, content, now: () => NOW, staffAuth: true, webhookSecret: "", providerName: "log", rateLimits: false });
  server = await new Promise((ok) => { const s = app.listen(0, () => ok(s)); });
  base = `http://127.0.0.1:${server.address().port}`;
  for (const [email, role] of [["editor@test.lr", "editor"], ["agro@test.lr", "agronomist"], ["agro2@test.lr", "agronomist"], ["officer@test.lr", "officer"], ["viewer@test.lr", "viewer"], ["admin@test.lr", "admin"]]) {
    await createStaff(db, { email, name: email.split("@")[0], role, counties: role === "officer" ? ["Bong"] : [], password: PW });
  }
});
afterEach(async () => {
  restoreFileTexts(content); // the content object is shared by the tests in this file
  await new Promise((ok) => server.close(ok));
  await db.close();
});

async function call(method, path, body, token) {
  const res = await fetch(base + path, { method, headers: { ...(body ? { "Content-Type": "application/json" } : {}), ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: body ? JSON.stringify(body) : undefined });
  return { status: res.status, body: await res.json() };
}
const tokenOf = async (email) => (await call("POST", "/api/staff/login", { email, password: PW })).body.token;
const riceFirstWeeding = (lang = "en") => adviceForFarmer({ language: lang, crops: [{ crop: "rice", planting_month: 5 }] }, content, NOW)[0].message;
const NEW_TEXT = "RICE: Weed now, 3 weeks after planting. Pull weeds by hand or hoe. Early weeding gives more rice. Dial *347# for help";

test("the editor lists every advice text with its review status", async () => {
  const r = await call("GET", "/api/content/texts", null, await tokenOf("editor@test.lr"));
  assert.equal(r.status, 200);
  const stages = [...content.crops.values()].reduce((n, c) => n + c.stages.length, 0);
  assert.equal(r.body.items.length, stages + content.pests.length);
  const weeding = r.body.items.find((i) => i.item === "stage:rice:first-weeding");
  assert.equal(weeding.crop_name, "Rice (upland)");
  assert.equal(weeding.langs.en.source, "file");
  assert.equal(weeding.langs.en.approved_by, null);
  assert.equal(r.body.items.find((i) => i.item === "stage:rice:harvest").hold_in_rain, true);
  assert.deepEqual(r.body.progress.en, { total: stages + content.pests.length, approved: 0 });
  assert.equal(r.body.progress.all_en_approved, false);
});

test("a draft reaches farmers only after a second person, an agronomist, approves it", async () => {
  const editor = await tokenOf("editor@test.lr");
  const agro = await tokenOf("agro@test.lr");
  const before = riceFirstWeeding();

  const d = await call("POST", "/api/content/texts", { item: "stage:rice:first-weeding", lang: "en", text: NEW_TEXT }, editor);
  assert.equal(d.status, 201);
  assert.equal(d.body.status, "draft");
  assert.equal(riceFirstWeeding(), before); // not live yet

  // Rejecting needs a reason. The editor fixes it; the new draft replaces the old one.
  assert.equal((await call("POST", `/api/content/texts/${d.body.id}/decide`, { approve: false }, agro)).status, 400);
  const rej = await call("POST", `/api/content/texts/${d.body.id}/decide`, { approve: false, note: "Say 'hoe' only: most farmers weed by hand." }, agro);
  assert.equal(rej.body.status, "rejected");
  const d2 = await call("POST", "/api/content/texts", { item: "stage:rice:first-weeding", text: NEW_TEXT }, editor);
  const d3 = await call("POST", "/api/content/texts", { item: "stage:rice:first-weeding", text: NEW_TEXT + "!" }, editor);
  assert.equal((await call("POST", `/api/content/texts/${d2.body.id}/decide`, { approve: true }, agro)).status, 400); // replaced by d3

  const ok = await call("POST", `/api/content/texts/${d3.body.id}/decide`, { approve: true }, agro);
  assert.equal(ok.body.status, "approved");
  assert.equal(ok.body.reviewer_name, "agro");
  assert.equal(riceFirstWeeding(), NEW_TEXT + "!"); // live at once

  const list = (await call("GET", "/api/content/texts", null, editor)).body;
  const weeding = list.items.find((i) => i.item === "stage:rice:first-weeding");
  assert.equal(weeding.langs.en.source, "approved");
  assert.equal(weeding.langs.en.approved_by, "agro");
  assert.equal(list.progress.en.approved, 1);
  const history = (await call("GET", "/api/content/texts/history?item=stage:rice:first-weeding&lang=en", null, editor)).body;
  assert.deepEqual(history.map((h) => h.status), ["approved", "replaced", "rejected"]);
  assert.equal((await db.get("SELECT COUNT(*) AS n FROM audit_log WHERE action LIKE 'content.%'")).n, 5); // 3 drafts, 1 rejection, 1 approval
});

test("nobody approves their own draft; texts must fit one SMS; unknown items are refused", async () => {
  const agro = await tokenOf("agro@test.lr");
  const own = await call("POST", "/api/content/texts", { item: "pest:fall-armyworm", text: "Likely FALL ARMYWORM. Pick and crush worms in the morning. Officer told." }, agro);
  assert.equal(own.status, 201);
  const self = await call("POST", `/api/content/texts/${own.body.id}/decide`, { approve: true }, agro);
  assert.equal(self.status, 400);
  assert.match(self.body.details[0], /another agronomist/);
  assert.equal((await call("POST", `/api/content/texts/${own.body.id}/decide`, { approve: true }, await tokenOf("agro2@test.lr"))).body.status, "approved");

  assert.equal((await call("POST", "/api/content/texts", { item: "pest:fall-armyworm", text: "x".repeat(161) }, agro)).status, 400);
  assert.equal((await call("POST", "/api/content/texts", { item: "stage:rice:dancing", text: "Hi" }, agro)).status, 400);
  assert.equal((await call("POST", "/api/content/texts", { item: "pest:fall-armyworm", lang: "fr", text: "Hi" }, agro)).status, 400);
});

test("roles: editors draft, agronomists approve, officers and viewers can't touch content", async () => {
  const editor = await tokenOf("editor@test.lr");
  const d = await call("POST", "/api/content/texts", { item: "stage:cassava:harvest", text: "CASSAVA: Harvest as you need it. Make gari within 2 days. Dial *347# for prices" }, editor);
  assert.equal((await call("POST", `/api/content/texts/${d.body.id}/decide`, { approve: true }, editor)).status, 403);
  assert.equal((await call("POST", "/api/content/texts/approve-as-is", { item: "stage:cassava:harvest" }, editor)).status, 403);
  for (const who of ["officer@test.lr", "viewer@test.lr"]) {
    const t = await tokenOf(who);
    assert.equal((await call("GET", "/api/content/texts", null, t)).status, 403, who);
    assert.equal((await call("POST", "/api/content/texts", { item: "stage:cassava:harvest", text: "x" }, t)).status, 403, who);
  }
  // Admins can do everything.
  assert.equal((await call("POST", `/api/content/texts/${d.body.id}/decide`, { approve: true }, await tokenOf("admin@test.lr"))).status, 200);
});

test("approving the file text as it is counts as a review; all of it gives the exit criterion", async () => {
  const agro = await tokenOf("agro@test.lr");
  const { items } = (await call("GET", "/api/content/texts", null, agro)).body;
  for (const i of items) {
    const r = await call("POST", "/api/content/texts/approve-as-is", { item: i.item, lang: "en" }, agro);
    assert.equal(r.status, 201, i.item);
  }
  assert.equal((await call("POST", "/api/content/texts/approve-as-is", { item: items[0].item }, agro)).status, 400); // already approved
  assert.equal((await call("POST", "/api/content/texts/approve-as-is", { item: items[0].item, lang: "kpe" }, agro)).status, 400); // no Kpelle yet
  const after = (await call("GET", "/api/content/texts", null, agro)).body.progress;
  assert.equal(after.all_en_approved, true);
  assert.equal((await call("GET", "/api/field-test", null, agro)).body.content_review.all_en_approved, true);
});

test("an approved translation goes to farmers who chose that language; others keep English", async () => {
  const editor = await tokenOf("editor@test.lr");
  const kpelle = "MALƐ: Kpɛ̃ɛ̃ yɛ sẽŋ. Dial *347# for help"; // placeholder Kpelle text for the test
  const d = await call("POST", "/api/content/texts", { item: "stage:rice:first-weeding", lang: "kpe", text: kpelle }, editor);
  assert.equal(riceFirstWeeding("kpe"), riceFirstWeeding("en")); // English until approved
  await call("POST", `/api/content/texts/${d.body.id}/decide`, { approve: true }, await tokenOf("agro@test.lr"));
  assert.equal(riceFirstWeeding("kpe"), kpelle);
  assert.notEqual(riceFirstWeeding("en"), kpelle);
  const progress = (await call("GET", "/api/content/texts", null, editor)).body.progress;
  assert.deepEqual(progress.translations, { total: 1, approved: 1 });
});

test("approved texts are loaded again when the server starts, and pest replies use them", async () => {
  const editor = await tokenOf("editor@test.lr");
  const text = "Likely FALL ARMYWORM. Check 20 plants today. Crush worms in the morning. Put ash in the funnel. Officer told.";
  const d = await call("POST", "/api/content/texts", { item: "pest:fall-armyworm", text }, editor);
  await call("POST", `/api/content/texts/${d.body.id}/decide`, { approve: true }, await tokenOf("agro@test.lr"));

  restoreFileTexts(content); // like a server restart: files only...
  assert.notEqual(content.pests.find((p) => p.id === "fall-armyworm").sms.en, text);
  assert.equal(await applyApprovedTexts(db, content), 1); // ...then the approved texts on top
  const r = await createPestReport(db, content, { phone: "0880000001", county: "Bong", crop: "rice", symptoms: ["holes", "caterpillar"], channel: "ussd" });
  assert.match(r.reply_sms, /^Likely FALL ARMYWORM\. Check 20 plants today\./);
  assert.equal((await listContent(db, content)).progress.en.approved, 1);
});

test("rain override: harvest advice waits while heavy rain is forecast, and goes out on a clear day", async () => {
  const f = await createFarmer(db, cleanFarmerInput({ phone: "0777000001", county: "Bong", consent: true, channel: "ussd", crops: [{ crop: "rice", planting_month: 2 }, { crop: "cassava", planting_month: 5 }] }, content));
  const forecast = (rain) => db.run("INSERT INTO weather_forecasts (county, days, fetched_at) VALUES ('Bong', ?, '2026-06-05T06:00:00Z') ON CONFLICT (county) DO UPDATE SET days = excluded.days",
    JSON.stringify([0, 1, 2].map((n) => ({ date: `2026-06-0${5 + n}`, rain_prob: rain, rain_mm: rain >= 70 ? 30 : 1, t_max: 30, t_min: 23, code: 2 }))));
  const ctx = { db, content, now: () => NOW };

  await forecast(90);
  const wet = await sendAdviceToFarmer(ctx, await getFarmer(db, f.id));
  assert.deepEqual(wet.map((r) => [r.crop, r.stage, r.action]), [["cassava", "early-weeding", "sent"], ["rice", "harvest", "rain_hold"]]);
  await forecast(10);
  const dry = await sendAdviceToFarmer(ctx, await getFarmer(db, f.id));
  assert.deepEqual(dry.map((r) => r.action), ["recent", "sent"]);
});
