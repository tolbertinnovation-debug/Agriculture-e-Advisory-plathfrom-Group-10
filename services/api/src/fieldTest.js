// Field-test measures (Sprint 2.4), for the MVP exit criteria in docs/build-plan.md:
//  1. USSD sign-up completion: of the people who start registering on *347#, how many finish?
//     (exit criterion: 80%+), and at which screen do the others give up?
//  2. "Did it help?": a few days after a pest report, the farmer gets one SMS
//     "Did the advice help? Reply 1 = Yes, 2 = No". The answers show which advice works.
import { sqlNow, sqlDaysAgo } from "./db.js";
import { sendSms } from "./messaging.js";

export const SIGNUP_STEPS = ["language", "county", "crop", "month", "consent"];
export const SIGNUP_TARGET = 0.8;
/** A USSD session times out after a few minutes; someone silent for this long has given up. */
export const ABANDON_MINUTES = 10;
export const FEEDBACK_AFTER_DAYS = 3;   // ask this long after the report...
export const FEEDBACK_UNTIL_DAYS = 10;  // ...but not about reports older than this
export const FEEDBACK_GAP_DAYS = 7;     // at most one question per farmer per week
export const FEEDBACK_ANSWER_DAYS = 7;  // a "1" or "2" counts as an answer for this long

// ---------------------------------------------------------------- 1. USSD sign-up funnel

/** Record the screen a phone has reached while registering on *347# (step = a SIGNUP_STEPS value). */
export async function trackSignup(db, phone, step, now = new Date()) {
  const t = sqlNow(now);
  await db.run(
    `INSERT INTO ussd_signups (phone, last_step, outcome, started_at, updated_at) VALUES (?, ?, 'in_progress', ?, ?)
     ON CONFLICT (phone) DO UPDATE SET last_step = excluded.last_step, outcome = 'in_progress', updated_at = excluded.updated_at
     WHERE ussd_signups.outcome <> 'registered'`,
    phone, step, t, t
  );
}

/** outcome: registered | cancelled. */
export async function finishSignup(db, phone, outcome, now = new Date()) {
  const t = sqlNow(now);
  await db.run(
    `INSERT INTO ussd_signups (phone, last_step, outcome, started_at, updated_at) VALUES (?, ?, ?, ?, ?)
     ON CONFLICT (phone) DO UPDATE SET last_step = excluded.last_step, outcome = excluded.outcome, updated_at = excluded.updated_at
     WHERE ussd_signups.outcome <> 'registered'`,
    phone, outcome === "registered" ? "done" : "consent", outcome, t, t
  );
}

export async function signupFunnel(db, { days = 30, now = new Date() } = {}) {
  const rows = await db.all(
    "SELECT outcome, last_step, updated_at FROM ussd_signups WHERE started_at >= ?", sqlDaysAgo(days, now)
  );
  const quiet = sqlDaysAgo(ABANDON_MINUTES / 1440, now);
  const out = { started: rows.length, registered: 0, cancelled: 0, abandoned: 0, in_progress: 0, gave_up_at: Object.fromEntries(SIGNUP_STEPS.map((s) => [s, 0])) };
  for (const r of rows) {
    if (r.outcome === "registered") out.registered++;
    else if (r.outcome === "cancelled") { out.cancelled++; out.gave_up_at.consent++; }
    else if (r.updated_at < quiet) { out.abandoned++; out.gave_up_at[r.last_step] = (out.gave_up_at[r.last_step] ?? 0) + 1; }
    else out.in_progress++;
  }
  // People still on the phone right now are not counted either way.
  const finished = out.registered + out.cancelled + out.abandoned;
  out.completion_rate = finished ? out.registered / finished : null;
  out.target = SIGNUP_TARGET;
  out.meets_target = out.completion_rate !== null && out.completion_rate >= SIGNUP_TARGET;
  return out;
}

// ---------------------------------------------------------------- 2. "Did it help?"

export function feedbackText(reportId, pestName) {
  const about = pestName ? `for ${pestName} (PR-${reportId})` : `for your report PR-${reportId}`;
  return `AgriConnect: Did our advice ${about} help? Reply 1 = Yes, 2 = No. Free SMS.`.slice(0, 160);
}

/**
 * Ask about pest reports made FEEDBACK_AFTER_DAYS ago (up to FEEDBACK_UNTIL_DAYS): registered farmers
 * only, not after STOP, not about rejected reports, once per report and at most once a week per farmer.
 */
export async function runFeedbackJob(ctx, { dryRun = false } = {}) {
  const { db, content } = ctx;
  const now = ctx.now();
  const reports = await db.all(
    `SELECT p.id, p.confirmed_pest, p.suggested_pest, p.county, f.id AS farmer_id, f.phone
       FROM pest_reports p JOIN farmers f ON f.id = p.farmer_id OR (p.farmer_id IS NULL AND f.phone = p.phone)
      WHERE p.status <> 'rejected' AND p.created_at <= ? AND p.created_at >= ?
        AND f.opted_out_at IS NULL
        AND NOT EXISTS (SELECT 1 FROM feedback_requests r WHERE r.report_id = p.id)
      ORDER BY p.id`,
    sqlDaysAgo(FEEDBACK_AFTER_DAYS, now), sqlDaysAgo(FEEDBACK_UNTIL_DAYS, now)
  );
  const summary = { due: reports.length, asked: 0, skipped_recent: 0, dry_run: dryRun };
  const askedNow = new Set();
  for (const r of reports) {
    const recent = askedNow.has(r.phone) || (await db.get("SELECT 1 AS x FROM feedback_requests WHERE phone = ? AND asked_at >= ?", r.phone, sqlDaysAgo(FEEDBACK_GAP_DAYS, now)));
    if (recent) { summary.skipped_recent++; continue; }
    askedNow.add(r.phone);
    summary.asked++;
    if (dryRun) continue;
    const pest = r.confirmed_pest ?? r.suggested_pest;
    const msg = await sendSms(db, { phone: r.phone, farmerId: r.farmer_id, body: feedbackText(r.id, content.pests.find((p) => p.id === pest)?.name), kind: "feedback" });
    await db.run(
      "INSERT INTO feedback_requests (report_id, farmer_id, phone, pest, county, message_id, asked_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
      r.id, r.farmer_id, r.phone, pest ?? null, r.county, msg.id ?? null, sqlNow(now)
    );
  }
  if (!dryRun) await db.run("INSERT INTO job_runs (job, run_date, trigger, result) VALUES ('feedback', ?, 'schedule', ?)", now.toISOString().slice(0, 10), JSON.stringify(summary));
  return summary;
}

/** True when today's "Did it help?" run is due (after `hour`:00) and has not happened yet. */
export async function feedbackRunDue(db, now, hour) {
  if (now.getUTCHours() < hour) return false;
  return !(await db.get("SELECT 1 AS x FROM job_runs WHERE job = 'feedback' AND run_date = ?", now.toISOString().slice(0, 10)));
}

/** Map an SMS to yes / no, or null if it isn't an answer. */
export function parseFeedback(text) {
  const w = String(text ?? "").trim().toUpperCase().replace(/[.!]+$/, "");
  if (["1", "YES", "Y", "1 YES"].includes(w)) return "yes";
  if (["2", "NO", "N", "2 NO"].includes(w)) return "no";
  return null;
}

/** Save the farmer's answer to their latest open question. Returns the request, or null if none is open. */
export async function answerFeedback(db, phone, answer, now = new Date()) {
  const open = await db.get(
    "SELECT * FROM feedback_requests WHERE phone = ? AND answer IS NULL AND asked_at >= ? ORDER BY id DESC LIMIT 1",
    phone, sqlDaysAgo(FEEDBACK_ANSWER_DAYS, now)
  );
  if (!open) return null;
  await db.run("UPDATE feedback_requests SET answer = ?, answered_at = ? WHERE id = ?", answer, sqlNow(now), open.id);
  return { ...open, answer };
}

export async function feedbackSummary(db, content, { days = 30, now = new Date(), counties } = {}) {
  const where = ["asked_at >= ?"];
  const args = [sqlDaysAgo(days, now)];
  if (counties) { where.push(`county IN (${counties.map(() => "?").join(",") || "NULL"})`); args.push(...counties); }
  const rows = await db.all(`SELECT pest, answer FROM feedback_requests WHERE ${where.join(" AND ")}`, ...args);
  const byPest = new Map();
  const total = { asked: 0, answered: 0, yes: 0, no: 0 };
  for (const r of rows) {
    const k = r.pest ?? "unknown";
    const p = byPest.get(k) ?? { pest: k, pest_name: content.pests.find((x) => x.id === k)?.name ?? "Not matched", asked: 0, answered: 0, yes: 0, no: 0 };
    for (const t of [p, total]) { t.asked++; if (r.answer) { t.answered++; t[r.answer]++; } }
    byPest.set(k, p);
  }
  const rate = (t) => ({ ...t, answer_rate: t.asked ? t.answered / t.asked : null, helped_rate: t.answered ? t.yes / t.answered : null });
  return { ...rate(total), by_pest: [...byPest.values()].map(rate).sort((a, b) => b.asked - a.asked) };
}
