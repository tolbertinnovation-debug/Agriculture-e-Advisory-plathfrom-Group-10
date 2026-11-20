import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { cleanFarmerInput, createFarmer, getFarmer, setOptedOut } from "../src/farmers.js";
import { sendSms, deliverQueued, markDelivery, requeueStuck, listMessages, messageStats, MAX_ATTEMPTS } from "../src/messaging.js";
import { sendAdviceToFarmer, runAdviceJob, adviceRunDue, nextAdviceRun, WEEKLY_CAP } from "../src/scheduler.js";
import { africasTalkingProvider, httpProvider, providerFromEnv } from "../src/providers/index.js";
import { content, startTestServer, newDb } from "./helpers.js";

let clock;
let ctx;
const day = 24 * 60 * 60 * 1000;
beforeEach(async () => {
  clock = new Date("2026-06-05T08:00:00Z"); // rice planted in May is in "first weeding"
  ctx = { db: await newDb(), content, now: () => clock };
});
const addFarmer = async (phone, crops = [{ crop: "rice", planting_month: 5 }]) =>
  (await createFarmer(ctx.db, cleanFarmerInput({ phone, county: "Bong", consent: true, crops }, content)));
const fakeProvider = (answers) => {
  const calls = [];
  return { name: "fake", calls, async send(m) { calls.push(m); const a = answers.shift() ?? { ok: true, id: `id-${calls.length}` }; if (a instanceof Error) throw a; return a; } };
};

// ---------------- queue & sender ----------------
test("messages are queued, then sent by the background sender", async () => {
  (await sendSms(ctx.db, { phone: "+231777000001", body: "Hello" }));
  assert.equal((await listMessages(ctx.db))[0].status, "queued");
  const provider = fakeProvider([]);
  const r = await deliverQueued(ctx.db, provider, { now: clock });
  assert.deepEqual(r, { sent: 1, retrying: 0, failed: 0 });
  const [m] = (await listMessages(ctx.db));
  assert.equal(m.status, "sent");
  assert.equal(m.provider_id, "id-1");
  assert.deepEqual(provider.calls, [{ to: "+231777000001", body: "Hello" }]);
});

test("a temporary failure is retried later, then gives up after the last attempt", async () => {
  (await sendSms(ctx.db, { phone: "+231777000001", body: "Hello" }));
  const provider = fakeProvider([{ ok: false, error: "gateway down", retry: true }, new Error("timeout"), { ok: false, error: "still down", retry: true }]);
  assert.equal((await deliverQueued(ctx.db, provider, { now: clock })).retrying, 1);
  assert.equal((await deliverQueued(ctx.db, provider, { now: clock })).retrying, 0, "not due yet: waits before retrying");
  clock = new Date(clock.getTime() + 3 * 60 * 1000);
  assert.equal((await deliverQueued(ctx.db, provider, { now: clock })).retrying, 1);
  clock = new Date(clock.getTime() + 5 * 60 * 1000);
  assert.equal((await deliverQueued(ctx.db, provider, { now: clock })).failed, 1);
  const [m] = (await listMessages(ctx.db));
  assert.equal(m.status, "failed");
  assert.equal(m.attempts, MAX_ATTEMPTS);
  assert.equal(m.last_error, "still down");
});

test("a permanent failure (e.g. invalid number) is not retried", async () => {
  (await sendSms(ctx.db, { phone: "+231777000001", body: "Hello" }));
  const r = await deliverQueued(ctx.db, fakeProvider([{ ok: false, error: "403 InvalidPhoneNumber", retry: false }]), { now: clock });
  assert.equal(r.failed, 1);
});

test("delivery reports update the status; messages stuck in 'sending' are re-queued", async () => {
  (await sendSms(ctx.db, { phone: "+231777000001", body: "One" }));
  (await sendSms(ctx.db, { phone: "+231777000002", body: "Two" }));
  await deliverQueued(ctx.db, fakeProvider([{ ok: true, id: "AT-1" }, { ok: true, id: "AT-2" }]), { now: clock });
  assert.equal((await markDelivery(ctx.db, "AT-1", "Success")), true);
  assert.equal((await markDelivery(ctx.db, "AT-2", "Failed")), true);
  assert.equal((await markDelivery(ctx.db, "AT-3", "Success")), false);
  assert.deepEqual((await messageStats(ctx.db)), { queued: 0, sent: 1, delivered: 1, failed: 1 });
  await ctx.db.run("UPDATE message_log SET status = 'sending' WHERE body = 'One'");
  assert.equal((await requeueStuck(ctx.db)), 1);
});

// ---------------- daily advice rules ----------------
test("advice is sent once per stage, with a reminder only after 28 days", async () => {
  const f = (await addFarmer("0777000001"));
  assert.deepEqual((await sendAdviceToFarmer(ctx, f)).map((r) => r.action), ["sent"]);
  assert.deepEqual((await sendAdviceToFarmer(ctx, f)).map((r) => r.action), ["recent"]);
  clock = new Date(clock.getTime() + 7 * day); // week 4: still first weeding
  assert.deepEqual((await sendAdviceToFarmer(ctx, f)).map((r) => r.action), ["recent"]);
  clock = new Date(clock.getTime() + 7 * day); // week 5: second weeding = new stage
  assert.deepEqual((await sendAdviceToFarmer(ctx, f)).map((r) => r.stage + ":" + r.action), ["second-weeding:sent"]);
  const advice = (await listMessages(ctx.db)).filter((m) => m.kind === "advice");
  assert.equal(advice.length, 2);
});

test("long stages get a reminder after 28 days", async () => {
  const f = (await addFarmer("0777000001", [{ crop: "cassava", planting_month: 1 }])); // mid-growth stage (weeks 13-35)
  assert.equal((await sendAdviceToFarmer(ctx, f))[0].action, "sent");
  clock = new Date(clock.getTime() + 27 * day);
  assert.equal((await sendAdviceToFarmer(ctx, f))[0].action, "recent");
  clock = new Date(clock.getTime() + 2 * day);
  assert.equal((await sendAdviceToFarmer(ctx, f))[0].action, "sent");
});

test("no advice to farmers who said STOP, or between seasons", async () => {
  const stopped = (await addFarmer("0777000001"));
  (await setOptedOut(ctx.db, stopped.id, true));
  assert.equal((await sendAdviceToFarmer(ctx, (await getFarmer(ctx.db, stopped.id))))[0].action, "opted_out");
  const offSeason = (await addFarmer("0777000002", [{ crop: "rice", planting_month: 9 }])); // planted last Sept: long harvested
  assert.equal((await sendAdviceToFarmer(ctx, offSeason))[0].action, "no_advice");
  assert.equal((await listMessages(ctx.db)).length, 0);
});

test(`at most ${WEEKLY_CAP} advice messages per farmer per week`, async () => {
  const fake = { ...content, crops: new Map([...content.crops].concat(["a", "b"].map((id) => [id, { ...content.crops.get("rice"), id }]))) };
  const c = { ...ctx, content: fake };
  const f = (await createFarmer(ctx.db, cleanFarmerInput({ phone: "0777000001", county: "Bong", consent: true,
    crops: ["rice", "cassava", "a", "b"].map((crop) => ({ crop, planting_month: 5 })) }, fake)));
  const actions = (await sendAdviceToFarmer(c, f)).map((r) => r.action);
  assert.equal(actions.filter((a) => a === "sent").length, WEEKLY_CAP);
  assert.ok(actions.includes("cap"));
});

test("the advice job covers every farmer, records the run, and a dry run sends nothing", async () => {
  (await addFarmer("0777000001"));
  (await addFarmer("0777000002", [{ crop: "cassava", planting_month: 4 }]));
  const dry = (await runAdviceJob(ctx, { dryRun: true }));
  assert.equal(dry.sent, 2);
  assert.equal((await listMessages(ctx.db)).length, 0);
  const real = (await runAdviceJob(ctx, { trigger: "schedule" }));
  assert.equal(real.sent, 2);
  assert.equal((await runAdviceJob(ctx)).recent, 2);
});

test("the daily schedule runs once a day after the set hour", async () => {
  const at = (iso) => new Date(iso);
  assert.equal((await adviceRunDue(ctx.db, at("2026-06-05T06:59:00Z"), 7)), false);
  assert.equal((await adviceRunDue(ctx.db, at("2026-06-05T07:00:00Z"), 7)), true);
  clock = at("2026-06-05T07:00:00Z");
  (await runAdviceJob(ctx, { trigger: "schedule" }));
  assert.equal((await adviceRunDue(ctx.db, at("2026-06-05T18:00:00Z"), 7)), false);
  assert.equal((await adviceRunDue(ctx.db, at("2026-06-06T07:01:00Z"), 7)), true);
  assert.equal(nextAdviceRun(at("2026-06-05T08:00:00Z"), 7).toISOString(), "2026-06-06T07:00:00.000Z");
});

// ---------------- providers ----------------
const fakeFetch = (status, json, calls = []) => {
  const f = async (url, opts) => { calls.push({ url, opts }); return { ok: status < 300, status, json: async () => json }; };
  f.calls = calls;
  return f;
};

test("Africa's Talking provider: success, retryable and permanent errors", async () => {
  const okFetch = fakeFetch(201, { SMSMessageData: { Recipients: [{ statusCode: 101, status: "Success", messageId: "ATXid_1" }] } });
  const at = africasTalkingProvider({ username: "sandbox", apiKey: "k", senderId: "AgriConnect", sandbox: true, fetch: okFetch });
  assert.deepEqual(await at.send({ to: "+231777000001", body: "Hi" }), { ok: true, id: "ATXid_1" });
  const call = okFetch.calls[0];
  assert.match(call.url, /sandbox/);
  assert.equal(call.opts.headers.apiKey, "k");
  assert.equal(call.opts.body.get("to"), "+231777000001");
  assert.equal(call.opts.body.get("from"), "AgriConnect");

  const balance = africasTalkingProvider({ username: "u", apiKey: "k", fetch: fakeFetch(201, { SMSMessageData: { Recipients: [{ statusCode: 405, status: "InsufficientBalance" }] } }) });
  assert.deepEqual(await balance.send({ to: "x", body: "y" }), { ok: false, error: "405 InsufficientBalance", retry: true });
  const invalid = africasTalkingProvider({ username: "u", apiKey: "k", fetch: fakeFetch(201, { SMSMessageData: { Recipients: [{ statusCode: 403, status: "InvalidPhoneNumber" }] } }) });
  assert.equal((await invalid.send({ to: "x", body: "y" })).retry, false);
  const down = africasTalkingProvider({ username: "u", apiKey: "k", fetch: async () => { throw new Error("ECONNRESET"); } });
  assert.equal((await down.send({ to: "x", body: "y" })).retry, true);
});

test("generic HTTP provider sends JSON with a bearer token", async () => {
  const f = fakeFetch(200, { id: "m-9" });
  const p = httpProvider({ url: "https://sms.example/send", token: "t", fetch: f });
  assert.deepEqual(await p.send({ to: "+231777000001", body: "Hi" }), { ok: true, id: "m-9" });
  assert.equal(f.calls[0].opts.headers.Authorization, "Bearer t");
  assert.deepEqual(JSON.parse(f.calls[0].opts.body), { to: "+231777000001", message: "Hi" });
  const busy = httpProvider({ url: "https://sms.example/send", fetch: fakeFetch(503, {}) });
  assert.equal((await busy.send({ to: "x", body: "y" })).retry, true);
});

test("provider settings are checked at start-up", async () => {
  assert.equal(providerFromEnv({}).name, "log");
  assert.throws(() => providerFromEnv({ SMS_PROVIDER: "africastalking" }), /AT_USERNAME/);
  assert.throws(() => providerFromEnv({ SMS_PROVIDER: "carrier-pigeon" }), /Unknown SMS_PROVIDER/);
});

// ---------------- HTTP ----------------
test("over HTTP: run the advice job, see job status, receive delivery reports", async () => {
  const api = await startTestServer({ now: () => new Date("2026-06-05T08:00:00Z") });
  try {
    await api.call("POST", "/api/farmers", { phone: "0777000001", county: "Bong", consent: true, crops: [{ crop: "rice", planting_month: 5 }] });
    assert.equal((await api.call("POST", "/api/jobs/advice/run", { dry_run: true })).body.sent, 1);
    assert.equal((await api.call("POST", "/api/jobs/advice/run", {})).body.sent, 1);
    const jobs = (await api.call("GET", "/api/jobs")).body;
    assert.equal(jobs.advice.last_runs.length, 1);
    assert.equal(jobs.sms.queued, 1);
    await api.db.run("UPDATE message_log SET status = 'sent', provider_id = 'AT-77'");
    const report = await api.call("POST", "/sms/status", { id: "AT-77", status: "Success" });
    assert.equal(report.body.updated, true);
  } finally {
    await api.close();
  }
});

test("with WEBHOOK_SECRET set, gateway webhooks need the secret", async () => {
  const { createApp } = await import("../src/app.js");
  const app = createApp({ db: await newDb(), content, webhookSecret: "gw-secret", staffAuth: false });
  const server = await new Promise((ok) => { const s = app.listen(0, () => ok(s)); });
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const post = (path) => fetch(base + path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ phoneNumber: "0777000001", text: "" }) });
    assert.equal((await post("/ussd")).status, 401);
    assert.equal((await post("/ussd?secret=wrong")).status, 401);
    const ok = await post("/ussd?secret=gw-secret");
    assert.equal(ok.status, 200);
    assert.match(await ok.text(), /^CON Welcome/);
  } finally {
    await new Promise((ok) => server.close(ok));
  }
});
