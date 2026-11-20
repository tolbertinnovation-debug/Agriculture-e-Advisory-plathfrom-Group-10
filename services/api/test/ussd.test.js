import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { openDb } from "../src/db.js";
import { handleUssd, normalizeInputs, USSD_MAX } from "../src/ussd.js";
import { handleInboundSms } from "../src/smsInbound.js";
import { getFarmerByPhone } from "../src/farmers.js";
import { listMessages } from "../src/messaging.js";
import { listQuestions } from "../src/questions.js";
import { listPestReports } from "../src/pestReports.js";
import { content, startTestServer } from "./helpers.js";

const PHONE = "+231777000111";
let ctx;
beforeEach(() => {
  ctx = { db: openDb(":memory:"), content, now: () => new Date("2026-06-05T08:00:00Z") };
});

/** Dial *347# and type the answers in order. Checks every screen fits on a phone. */
function dial(answers, phone = PHONE) {
  const reply = handleUssd(ctx, { phoneNumber: phone, text: answers.join("*") });
  assert.ok(reply.text.length <= USSD_MAX, `Screen too long (${reply.text.length}):\n${reply.text}`);
  return reply;
}
const sms = (phone = PHONE) => listMessages(ctx.db, { phone }).reverse().map((m) => m.body);

// Answers for: Register → Liberian English → Bong → Rice → plant in May → I agree
const REGISTER_KOLLIE = ["1", "1", "2", "1", "5", "1"];

test("0 goes back and 00 returns to the main menu", () => {
  assert.deepEqual(normalizeInputs(""), []);
  assert.deepEqual(normalizeInputs("1*2*0*3"), ["1", "3"]);
  assert.deepEqual(normalizeInputs("1*2*00*4"), ["4"]);
  assert.deepEqual(normalizeInputs("0"), []);
});

test("a new number sees the welcome menu", () => {
  const r = dial([]);
  assert.equal(r.type, "CON");
  assert.match(r.text, /Welcome to AgriConnect/);
  assert.match(r.text, /1 Register/);
});

test("every screen of registration fits on a phone, step by step", () => {
  for (let n = 0; n < REGISTER_KOLLIE.length; n++) assert.equal(dial(REGISTER_KOLLIE.slice(0, n)).type, "CON");
});

test("registration over USSD creates the farmer and sends welcome + first advice by SMS", () => {
  const r = dial(REGISTER_KOLLIE);
  assert.equal(r.type, "END");
  assert.match(r.text, /registered/);
  const farmer = getFarmerByPhone(ctx.db, PHONE);
  assert.equal(farmer.county, "Bong");
  assert.equal(farmer.channel, "ussd");
  assert.deepEqual(farmer.crops, [{ crop: "rice", planting_month: 5 }]);
  const inbox = sms();
  assert.match(inbox[0], /Welcome to AgriConnect/);
  assert.match(inbox[1], /^RICE: Do your first weeding/);
});

test("county list has a second page", () => {
  const page2 = dial(["1", "1", "8"]);
  assert.match(page2.text, /5 Nimba/);
  dial(["1", "1", "8", "5", "2", "4", "1"]); // Nimba, cassava, April, agree
  assert.equal(getFarmerByPhone(ctx.db, PHONE).county, "Nimba");
});

test("registering for all crops asks the planting month for each", () => {
  assert.match(dial(["1", "1", "2", "3"]).text, /Month you plant RICE/);
  assert.match(dial(["1", "1", "2", "3", "5"]).text, /Month you plant CASSAVA/);
  dial(["1", "1", "2", "3", "5", "4", "1"]);
  assert.equal(getFarmerByPhone(ctx.db, PHONE).crops.length, 2);
});

test("a wrong answer repeats the screen", () => {
  const r = dial(["1", "9"]);
  assert.match(r.text, /^Try again\.\nChoose language/);
});

test("cancel at the consent screen does not register", () => {
  const r = dial(["1", "1", "2", "1", "5", "2"]);
  assert.match(r.text, /cancelled/);
  assert.equal(getFarmerByPhone(ctx.db, PHONE), null);
});

test("a registered farmer sees the full menu with their county", () => {
  dial(REGISTER_KOLLIE);
  const r = dial([]);
  assert.match(r.text, /AgriConnect - Bong/);
  assert.match(r.text, /6 My profile/);
});

test("crop advice can be sent by SMS on request", () => {
  dial(REGISTER_KOLLIE);
  const screen = dial(["1"]);
  assert.match(screen.text, /^RICE: Do your first weeding/);
  assert.match(screen.text, /1 Get by SMS$/);
  const before = sms().length;
  assert.equal(dial(["1", "1"]).text, "Sent! Check your SMS.");
  assert.equal(sms().length, before + 1);
});

test("registered farmer reports a pest: report saved, officer can see it, SMS reply sent", () => {
  dial(REGISTER_KOLLIE);
  assert.match(dial(["4"]).text, /What do you see\?/);
  const r = dial(["4", "1", "1"]); // worms eating leaves, rice
  assert.equal(r.type, "END");
  assert.match(r.text, /Ref PR-1/);
  const [report] = listPestReports(ctx.db, { county: "Bong" });
  assert.equal(report.suggested_pest, "fall-armyworm");
  assert.equal(report.channel, "ussd");
  assert.match(sms().at(-1), /FALL ARMYWORM/);
});

test("unregistered farmer can report a pest after choosing a county", () => {
  const r = dial(["2", "2", "2", "8", "5"]); // pest, yellow twisted, cassava, more, Nimba
  assert.match(r.text, /Report sent/);
  const [report] = listPestReports(ctx.db, {});
  assert.equal(report.county, "Nimba");
  assert.equal(report.suggested_pest, "cassava-mosaic");
});

test("call-back request goes to the officer queue for the farmer's county", () => {
  dial(REGISTER_KOLLIE);
  const r = dial(["5", "1"]);
  assert.match(r.text, /officer in Bong will call you/);
  const [q] = listQuestions(ctx.db, { county: "Bong", status: "open" });
  assert.equal(q.kind, "callback");
});

test("profile: change language and stop / start SMS", () => {
  dial(REGISTER_KOLLIE);
  assert.match(dial(["6"]).text, /SMS advice: ON/);
  dial(["6", "1", "2"]);
  assert.equal(getFarmerByPhone(ctx.db, PHONE).language, "kpe");
  dial(["6", "2"]);
  assert.ok(getFarmerByPhone(ctx.db, PHONE).opted_out_at);
  assert.match(dial(["6"]).text, /SMS advice: OFF/);
  dial(["6", "2"]);
  assert.equal(getFarmerByPhone(ctx.db, PHONE).opted_out_at, null);
});

test("the longest county name still fits on the profile screen", () => {
  dial(["1", "4", "5", "3", "5", "5", "1"]); // Kissi, Grand Cape Mount, all crops
  assert.match(dial(["6"]).text, /Grand Cape Mount/);
});

test("non-Liberian numbers are refused politely", () => {
  const r = handleUssd(ctx, { phoneNumber: "+1555", text: "" });
  assert.equal(r.type, "END");
});

test("SMS keywords: HELP, ASK, STOP, START", () => {
  dial(REGISTER_KOLLIE);
  assert.match(handleInboundSms(ctx, { from: PHONE, text: "hello" }).reply, /dial \*347#/);
  const ask = handleInboundSms(ctx, { from: PHONE, text: "ask my pepper leaves are yellow" });
  assert.match(ask.reply, /officer in Bong/);
  assert.equal(listQuestions(ctx.db, {})[0].body, "my pepper leaves are yellow");
  handleInboundSms(ctx, { from: PHONE, text: "STOP" });
  assert.ok(getFarmerByPhone(ctx.db, PHONE).opted_out_at);
  handleInboundSms(ctx, { from: PHONE, text: "start" });
  assert.equal(getFarmerByPhone(ctx.db, PHONE).opted_out_at, null);
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
