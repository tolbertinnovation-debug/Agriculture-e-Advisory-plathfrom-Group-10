import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { handleUssd, normalizeInputs, USSD_MAX } from "../src/ussd.js";
import { handleInboundSms } from "../src/smsInbound.js";
import { getFarmerByPhone } from "../src/farmers.js";
import { listMessages } from "../src/messaging.js";
import { listQuestions } from "../src/questions.js";
import { listPestReports } from "../src/pestReports.js";
import { content, startTestServer, newDb } from "./helpers.js";

const PHONE = "+231777000111";
let ctx;
beforeEach(async () => {
  ctx = { db: await newDb(), content, now: () => new Date("2026-06-05T08:00:00Z") };
});

/** Dial *347# and type the answers in order. Checks every screen fits on a phone. */
async function dial(answers, phone = PHONE) {
  const reply = (await handleUssd(ctx, { phoneNumber: phone, text: answers.join("*") }));
  assert.ok(reply.text.length <= USSD_MAX, `Screen too long (${reply.text.length}):\n${reply.text}`);
  return reply;
}
const sms = async (phone = PHONE) => (await listMessages(ctx.db, { phone })).reverse().map((m) => m.body);

// Answers for: Register → Liberian English → Bong → Rice → plant in May → I agree
const REGISTER_KOLLIE = ["1", "1", "2", "1", "5", "1"];

test("0 goes back and 00 returns to the main menu", async () => {
  assert.deepEqual(normalizeInputs(""), []);
  assert.deepEqual(normalizeInputs("1*2*0*3"), ["1", "3"]);
  assert.deepEqual(normalizeInputs("1*2*00*4"), ["4"]);
  assert.deepEqual(normalizeInputs("0"), []);
});

test("a new number sees the welcome menu", async () => {
  const r = (await dial([]));
  assert.equal(r.type, "CON");
  assert.match(r.text, /Welcome to AgriConnect/);
  assert.match(r.text, /1 Register/);
});

test("every screen of registration fits on a phone, step by step", async () => {
  for (let n = 0; n < REGISTER_KOLLIE.length; n++) assert.equal((await dial(REGISTER_KOLLIE.slice(0, n))).type, "CON");
});

test("registration over USSD creates the farmer and sends welcome + first advice by SMS", async () => {
  const r = (await dial(REGISTER_KOLLIE));
  assert.equal(r.type, "END");
  assert.match(r.text, /registered/);
  const farmer = (await getFarmerByPhone(ctx.db, PHONE));
  assert.equal(farmer.county, "Bong");
  assert.equal(farmer.channel, "ussd");
  assert.deepEqual(farmer.crops, [{ crop: "rice", planting_month: 5 }]);
  const inbox = (await sms());
  assert.match(inbox[0], /Welcome to AgriConnect/);
  assert.match(inbox[1], /^RICE: Do your first weeding/);
});

test("county list has a second page", async () => {
  const page2 = (await dial(["1", "1", "8"]));
  assert.match(page2.text, /5 Nimba/);
  (await dial(["1", "1", "8", "5", "2", "4", "1"])); // Nimba, cassava, April, agree
  assert.equal((await getFarmerByPhone(ctx.db, PHONE)).county, "Nimba");
});

test("registering for all crops asks the planting month for each", async () => {
  assert.match((await dial(["1", "1", "2", "3"])).text, /Month you plant RICE/);
  assert.match((await dial(["1", "1", "2", "3", "5"])).text, /Month you plant CASSAVA/);
  (await dial(["1", "1", "2", "3", "5", "4", "1"]));
  assert.equal((await getFarmerByPhone(ctx.db, PHONE)).crops.length, 2);
});

test("a wrong answer repeats the screen", async () => {
  const r = (await dial(["1", "9"]));
  assert.match(r.text, /^Try again\.\nChoose language/);
});

test("cancel at the consent screen does not register", async () => {
  const r = (await dial(["1", "1", "2", "1", "5", "2"]));
  assert.match(r.text, /cancelled/);
  assert.equal((await getFarmerByPhone(ctx.db, PHONE)), null);
});

test("a registered farmer sees the full menu with their county", async () => {
  (await dial(REGISTER_KOLLIE));
  const r = (await dial([]));
  assert.match(r.text, /AgriConnect - Bong/);
  assert.match(r.text, /6 My profile/);
});

test("crop advice can be sent by SMS on request", async () => {
  (await dial(REGISTER_KOLLIE));
  const screen = (await dial(["1"]));
  assert.match(screen.text, /^RICE: Do your first weeding/);
  assert.match(screen.text, /1 Get by SMS$/);
  const before = (await sms()).length;
  assert.equal((await dial(["1", "1"])).text, "Sent! Check your SMS.");
  assert.equal((await sms()).length, before + 1);
});

test("registered farmer reports a pest: report saved, officer can see it, SMS reply sent", async () => {
  (await dial(REGISTER_KOLLIE));
  assert.match((await dial(["4"])).text, /What do you see\?/);
  const r = (await dial(["4", "1", "1"])); // worms eating leaves, rice
  assert.equal(r.type, "END");
  assert.match(r.text, /Ref PR-1/);
  const [report] = (await listPestReports(ctx.db, { county: "Bong" }));
  assert.equal(report.suggested_pest, "fall-armyworm");
  assert.equal(report.channel, "ussd");
  assert.match((await sms()).at(-1), /FALL ARMYWORM/);
});

test("unregistered farmer can report a pest after choosing a county", async () => {
  const r = (await dial(["2", "2", "2", "8", "5"])); // pest, yellow twisted, cassava, more, Nimba
  assert.match(r.text, /Report sent/);
  const [report] = (await listPestReports(ctx.db, {}));
  assert.equal(report.county, "Nimba");
  assert.equal(report.suggested_pest, "cassava-mosaic");
});

test("call-back request goes to the officer queue for the farmer's county", async () => {
  (await dial(REGISTER_KOLLIE));
  const r = (await dial(["5", "1"]));
  assert.match(r.text, /officer in Bong will call you/);
  const [q] = (await listQuestions(ctx.db, { county: "Bong", status: "open" }));
  assert.equal(q.kind, "callback");
});

test("profile: change language and stop / start SMS", async () => {
  (await dial(REGISTER_KOLLIE));
  assert.match((await dial(["6"])).text, /SMS advice: ON/);
  (await dial(["6", "1", "2"]));
  assert.equal((await getFarmerByPhone(ctx.db, PHONE)).language, "kpe");
  (await dial(["6", "2"]));
  assert.ok((await getFarmerByPhone(ctx.db, PHONE)).opted_out_at);
  assert.match((await dial(["6"])).text, /SMS advice: OFF/);
  (await dial(["6", "2"]));
  assert.equal((await getFarmerByPhone(ctx.db, PHONE)).opted_out_at, null);
});

test("the longest county name still fits on the profile screen", async () => {
  (await dial(["1", "4", "5", "3", "5", "5", "1"])); // Kissi, Grand Cape Mount, all crops
  assert.match((await dial(["6"])).text, /Grand Cape Mount/);
});

test("non-Liberian numbers are refused politely", async () => {
  const r = (await handleUssd(ctx, { phoneNumber: "+1555", text: "" }));
  assert.equal(r.type, "END");
});

test("SMS keywords: HELP, ASK, STOP, START", async () => {
  (await dial(REGISTER_KOLLIE));
  assert.match((await handleInboundSms(ctx, { from: PHONE, text: "hello" })).reply, /dial \*347#/);
  const ask = (await handleInboundSms(ctx, { from: PHONE, text: "ask my pepper leaves are yellow" }));
  assert.match(ask.reply, /officer in Bong/);
  assert.equal((await listQuestions(ctx.db, {}))[0].body, "my pepper leaves are yellow");
  (await handleInboundSms(ctx, { from: PHONE, text: "STOP" }));
  assert.ok((await getFarmerByPhone(ctx.db, PHONE)).opted_out_at);
  (await handleInboundSms(ctx, { from: PHONE, text: "start" }));
  assert.equal((await getFarmerByPhone(ctx.db, PHONE)).opted_out_at, null);
});

test("over HTTP: /ussd answers in CON/END plain text, like a telco gateway expects", async () => {
  const api = await startTestServer();
  try {
    const res = await fetch(api.base + "/ussd", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ sessionId: "abc", serviceCode: "*347#", phoneNumber: PHONE, text: "" })
    });
    assert.match(res.headers.get("content-type"), /text\/plain/);
    assert.match(await res.text(), /^CON Welcome to AgriConnect/);

    const inbound = await api.call("POST", "/sms/inbound", { from: PHONE, text: "HELP" });
    assert.equal(inbound.status, 200);
    const msgs = await api.call("GET", `/api/messages?phone=${encodeURIComponent(PHONE)}`);
    assert.deepEqual(msgs.body.map((m) => m.direction), ["out", "in"]);
  } finally {
    await api.close();
  }
});
