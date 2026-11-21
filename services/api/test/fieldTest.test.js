// Sprint 2.4: field-test measures. USSD sign-up completion and "Did it help?" answers.
import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { handleUssd } from "../src/ussd.js";
import { handleInboundSms } from "../src/smsInbound.js";
import { signupFunnel, runFeedbackJob, feedbackSummary, feedbackRunDue, parseFeedback, feedbackText } from "../src/fieldTest.js";
import { sqlDaysAgo } from "../src/db.js";
import { createApp } from "../src/app.js";
import { createStaff } from "../src/staff.js";
import { content, newDb } from "./helpers.js";

let ctx, clock;
beforeEach(async () => {
  clock = new Date("2026-06-05T08:00:00Z");
  ctx = { db: await newDb(), content, now: () => clock };
});
afterEach(async () => { await ctx.db.close(); });

const later = (minutes) => { clock = new Date(clock.getTime() + minutes * 60000); };
/** Dial *347# one screen at a time, like a real phone: each answer is a new request. */
async function stepThrough(phone, answers) {
  let reply = await handleUssd(ctx, { phoneNumber: phone, text: "" });
  for (let i = 1; i <= answers.length; i++) reply = await handleUssd(ctx, { phoneNumber: phone, text: answers.slice(0, i).join("*") });
  return reply;
}
const REGISTER = ["1", "1", "2", "1", "5", "1"]; // register, English, Bong, rice, May, I agree
const lastSms = async (phone) => (await ctx.db.get("SELECT body FROM message_log WHERE phone = ? AND direction = 'out' ORDER BY id DESC LIMIT 1", phone))?.body;
const sms = (from, text) => handleInboundSms(ctx, { from, text });

test("USSD sign-up completion: finished, cancelled, gave up (and where), still dialling", async () => {
  await stepThrough("0777000001", REGISTER);                   // finishes
  await stepThrough("0777000002", ["1", "1"]);                 // stops at the county screen
  await stepThrough("0777000003", ["1", "2", "2", "1", "5", "2"]); // cancels at consent
  await stepThrough("0777000004", ["1", "1", "2", "1"]);       // gives up at the planting month
  await stepThrough("0777000005", ["2"]);                      // reports a pest: not a sign-up at all
  later(15);
  await stepThrough("0777000006", ["1"]);                      // on the language screen right now

  const f = await signupFunnel(ctx.db, { now: clock });
  assert.equal(f.started, 5);
  assert.equal(f.registered, 1);
  assert.equal(f.cancelled, 1);
  assert.equal(f.abandoned, 2);
  assert.equal(f.in_progress, 1);
  assert.deepEqual(f.gave_up_at, { language: 0, county: 1, crop: 0, month: 1, consent: 1 });
  assert.equal(f.completion_rate, 1 / 4);
  assert.equal(f.target, 0.8);
  assert.equal(f.meets_target, false);

  // Someone who gave up can come back and finish: they then count as registered.
  await stepThrough("0777000002", REGISTER);
  const g = await signupFunnel(ctx.db, { now: clock });
  assert.equal(g.registered, 2);
  assert.equal(g.abandoned, 1);
  // A registered farmer dialling again is not a new sign-up.
  await stepThrough("0777000001", ["6"]);
  assert.equal((await signupFunnel(ctx.db, { now: clock })).started, 5);
});

test("'Did it help?' is asked 3 days after a pest report, once, and only to farmers who can get SMS", async () => {
  for (const p of ["0777000001", "0777000002", "0777000003"]) await stepThrough(p, REGISTER);
  for (const p of ["0777000001", "0777000002", "0777000003"]) await handleUssd(ctx, { phoneNumber: p, text: "4*1*1" });
  await handleUssd(ctx, { phoneNumber: "0777000001", text: "4*1*1" }); // a second report from farmer 1
  await handleUssd(ctx, { phoneNumber: "0888000009", text: "4*1*1*2" }); // unregistered: never asked (no consent to push SMS)
  await ctx.db.run("UPDATE pest_reports SET created_at = ?", sqlDaysAgo(4, clock));
  await ctx.db.run("UPDATE pest_reports SET status = 'rejected' WHERE phone = '+231777000002'");
  await sms("0777000003", "STOP");

  assert.equal(await feedbackRunDue(ctx.db, clock, 7), true);
  const r = await runFeedbackJob(ctx);
  assert.deepEqual(r, { due: 2, asked: 1, skipped_recent: 1, dry_run: false }); // farmer 1 has 2 reports: one question a week
  assert.equal(await lastSms("+231777000001"), "AgriConnect: Did our advice for Fall armyworm (PR-1) help? Reply 1 = Yes, 2 = No. Free SMS.");
  assert.equal(await feedbackRunDue(ctx.db, clock, 7), false);
  assert.equal((await runFeedbackJob(ctx)).asked, 0); // never twice about the same report

  // A week later the second report is asked about; reports over 10 days old are left alone.
  later(60 * 24 * 7);
  const next = await runFeedbackJob(ctx);
  assert.equal(next.asked, 0); // PR-4 is now 11 days old
  assert.ok(feedbackText(12345, "Cassava mosaic disease").length <= 160);
});

test("answers: 1 = helped; 2 = an officer is asked to call; no open question = normal reply", async () => {
  for (const p of ["0777000001", "0777000002"]) { await stepThrough(p, REGISTER); await handleUssd(ctx, { phoneNumber: p, text: "4*1*1" }); }
  await ctx.db.run("UPDATE pest_reports SET created_at = ?", sqlDaysAgo(3, clock));

  assert.match((await sms("0777000001", "1")).reply, /AgriConnect: dial \*347#/); // nothing asked yet
  await runFeedbackJob(ctx);
  assert.match((await sms("0777000001", "1")).reply, /glad it helped/);
  assert.match((await sms("0777000001", "2")).reply, /AgriConnect: dial \*347#/); // already answered
  const no = await sms("0777000002", " No ");
  assert.match(no.reply, /officer in Bong will call you/);
  const q = await ctx.db.get("SELECT * FROM questions WHERE kind = 'callback'");
  assert.equal(q.phone, "+231777000002");
  assert.match(q.body, /PR-2 \(Fall armyworm\) did not help/);

  const s = await feedbackSummary(ctx.db, content, { now: clock });
  assert.equal(s.asked, 2);
  assert.equal(s.answered, 2);
  assert.equal(s.helped_rate, 0.5);
  assert.equal(s.by_pest[0].pest_name, "Fall armyworm");
  assert.equal((await feedbackSummary(ctx.db, content, { now: clock, counties: ["Nimba"] })).asked, 0);
});

test("parseFeedback understands the usual ways of answering", () => {
  for (const t of ["1", "yes", "YES.", "y", " 1 "]) assert.equal(parseFeedback(t), "yes", t);
  for (const t of ["2", "no", "No!", "n"]) assert.equal(parseFeedback(t), "no", t);
  for (const t of ["3", "ask yes", "", null]) assert.equal(parseFeedback(t), null, String(t));
});

test("over HTTP: field-test numbers for staff who see stats; only job runners send the questions", async () => {
  const app = createApp({ db: ctx.db, content, now: () => clock, staffAuth: true, webhookSecret: "", providerName: "log", rateLimits: false });
  const server = await new Promise((ok) => { const s = app.listen(0, () => ok(s)); });
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const PW = "correct-horse-battery";
    await createStaff(ctx.db, { email: "admin@test.lr", name: "Admin", role: "admin", password: PW });
    await createStaff(ctx.db, { email: "viewer@test.lr", name: "Viewer", role: "viewer", password: PW });
    await createStaff(ctx.db, { email: "lead@test.lr", name: "Lead", role: "lead", counties: ["Bong"], password: PW });
    const call = async (method, path, token, body) => {
      const res = await fetch(base + path, { method, headers: { Authorization: `Bearer ${token}`, ...(body ? { "Content-Type": "application/json" } : {}) }, body: body ? JSON.stringify(body) : undefined });
      return { status: res.status, body: await res.json() };
    };
    const token = async (email) => (await (await fetch(base + "/api/staff/login", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ email, password: PW }) })).json()).token;
    await stepThrough("0777000001", REGISTER);

    const viewer = await token("viewer@test.lr");
    const r = await call("GET", "/api/field-test?days=7", viewer);
    assert.equal(r.status, 200);
    assert.equal(r.body.days, 7);
    assert.equal(r.body.ussd_signup.registered, 1);
    assert.equal(r.body.ussd_signup.completion_rate, 1);
    assert.equal(r.body.did_it_help.asked, 0);
    assert.equal((await call("GET", "/api/field-test", await token("lead@test.lr"))).status, 403);
    assert.equal((await call("POST", "/api/jobs/feedback/run", viewer, {})).status, 403);
    const run = await call("POST", "/api/jobs/feedback/run", await token("admin@test.lr"), { dry_run: true });
    assert.equal(run.status, 200);
    assert.equal(run.body.dry_run, true);
  } finally {
    await new Promise((ok) => server.close(ok));
  }
});
