// Automatic crop advice + background workers.
//
// Advice rules (blueprint §2 and §6), per farmer and crop:
//   - send the advice when the farmer reaches a NEW stage of the crop calendar;
//   - in a long stage, send a reminder at most every REMINDER_DAYS days;
//   - never more than WEEKLY_CAP advice messages in 7 days per farmer;
//   - never to farmers who said STOP; nothing between seasons.
// Liberia uses GMT all year, so UTC times are local times.
import { adviceForFarmer } from "./engine.js";
import { sendSms, deliverQueued, requeueStuck } from "./messaging.js";
import { getFarmer } from "./farmers.js";
import { refreshWeather, sendWeatherAlerts } from "./weather.js";

export const REMINDER_DAYS = 28;
export const WEEKLY_CAP = 3;
const DAY = 24 * 60 * 60 * 1000;

/**
 * Queue this week's advice for one farmer, following the rules above.
 * Returns one line per crop: { crop, stage, action: "sent" | "recent" | "cap" | "opted_out" | "no_advice" }.
 */
export function sendAdviceToFarmer(ctx, farmer, { dryRun = false } = {}) {
  const { db, content } = ctx;
  const now = ctx.now();
  const results = [];
  let sentThisWeek = db
    .prepare("SELECT COUNT(*) AS n FROM advice_sends WHERE farmer_id = ? AND sent_at >= ?")
    .get(farmer.id, new Date(now.getTime() - 7 * DAY).toISOString()).n;

  for (const advice of adviceForFarmer(farmer, content, now)) {
    const line = { crop: advice.crop, stage: advice.stage };
    if (!advice.message) { results.push({ ...line, action: "no_advice" }); continue; }
    if (farmer.opted_out_at) { results.push({ ...line, action: "opted_out" }); continue; }
    const last = db
      .prepare("SELECT sent_at FROM advice_sends WHERE farmer_id = ? AND crop = ? AND stage = ? ORDER BY sent_at DESC LIMIT 1")
      .get(farmer.id, advice.crop, advice.stage);
    if (last && now - new Date(last.sent_at) < REMINDER_DAYS * DAY) { results.push({ ...line, action: "recent" }); continue; }
    if (sentThisWeek >= WEEKLY_CAP) { results.push({ ...line, action: "cap" }); continue; }

    if (!dryRun) {
      const msg = sendSms(db, { phone: farmer.phone, farmerId: farmer.id, body: advice.message, kind: "advice" });
      db.prepare("INSERT INTO advice_sends (farmer_id, crop, stage, message_id, sent_at) VALUES (?, ?, ?, ?, ?)")
        .run(farmer.id, advice.crop, advice.stage, msg.id ?? null, now.toISOString());
    }
    sentThisWeek++;
    results.push({ ...line, action: "sent" });
  }
  return results;
}

/** Run the advice job for every registered farmer. Returns a summary and records the run. */
export function runAdviceJob(ctx, { dryRun = false, trigger = "manual" } = {}) {
  const { db } = ctx;
  const summary = { farmers: 0, sent: 0, recent: 0, cap: 0, opted_out: 0, no_advice: 0, dry_run: dryRun };
  const ids = db.prepare("SELECT id FROM farmers ORDER BY id").all().map((r) => r.id);
  for (const id of ids) {
    summary.farmers++;
    for (const r of sendAdviceToFarmer(ctx, getFarmer(db, id), { dryRun })) summary[r.action]++;
  }
  if (!dryRun) {
    db.prepare("INSERT INTO job_runs (job, run_date, trigger, result) VALUES ('advice', ?, ?, ?)")
      .run(ctx.now().toISOString().slice(0, 10), trigger, JSON.stringify(summary));
  }
  return summary;
}

export function lastJobRuns(db, job = "advice", limit = 5) {
  return db
    .prepare("SELECT * FROM job_runs WHERE job = ? ORDER BY id DESC LIMIT ?")
    .all(job, limit)
    .map((r) => ({ ...r, result: r.result ? JSON.parse(r.result) : null }));
}

/** When the daily job runs next (UTC = Liberia time). */
export function nextAdviceRun(now, hour) {
  const next = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), hour, 0, 0));
  if (next <= now) next.setUTCDate(next.getUTCDate() + 1);
  return next;
}

/** True when today's scheduled run is due and has not happened yet. */
export function adviceRunDue(db, now, hour) {
  if (now.getUTCHours() < hour) return false;
  const today = now.toISOString().slice(0, 10);
  return !db.prepare("SELECT 1 FROM job_runs WHERE job = 'advice' AND trigger = 'schedule' AND run_date = ?").get(today);
}

/**
 * Start the background workers inside the API process:
 *  - the SMS sender, every `sendEveryMs`
 *  - the daily advice job at `adviceHour`:00 (checked every minute)
 * Returns stop().
 */
/** Refresh all county forecasts, then send rain alerts (only in the daytime, 06:00-19:00 Liberia time). */
export async function weatherCycle(ctx, { fetch, url, log = console } = {}) {
  const r = await refreshWeather(ctx.db, { fetch, url, now: ctx.now() });
  if (r.failed.length) log.warn(`Weather: ${r.updated} counties updated, ${r.failed.length} failed (${r.failed[0]})`);
  const hour = ctx.now().getUTCHours();
  const alerts = hour >= 6 && hour < 19 ? sendWeatherAlerts(ctx) : [];
  for (const a of alerts) log.log(`Rain alert for ${a.county}: ${a.reach} farmers`);
  return { ...r, alerts };
}

export function startWorkers(ctx, provider, { adviceHour = 7, sendEveryMs = 2000, scheduler = true, weather = true, weatherEveryHours = 3, weatherUrl, log = console } = {}) {
  const stuck = requeueStuck(ctx.db);
  if (stuck) log.log(`Re-queued ${stuck} message(s) that were being sent when the server stopped.`);

  let sending = false;
  const sendTimer = setInterval(async () => {
    if (sending) return;
    sending = true;
    try {
      const r = await deliverQueued(ctx.db, provider, { now: ctx.now() });
      if (r.sent || r.retrying || r.failed) log.log(`SMS via ${provider.name}: ${r.sent} sent, ${r.retrying} will retry, ${r.failed} failed`);
    } catch (err) {
      log.error("SMS sender error:", err);
    } finally {
      sending = false;
    }
  }, sendEveryMs);

  let adviceTimer = null;
  if (scheduler) {
    const check = () => {
      try {
        if (adviceRunDue(ctx.db, ctx.now(), adviceHour)) {
          const s = runAdviceJob(ctx, { trigger: "schedule" });
          log.log(`Daily advice: ${s.sent} queued for ${s.farmers} farmers (${s.recent} already had it, ${s.cap} over the weekly limit).`);
        }
      } catch (err) {
        log.error("Advice job error:", err);
      }
    };
    check();
    adviceTimer = setInterval(check, 60 * 1000);
  }
  let weatherTimer = null;
  if (weather) {
    const run = () => weatherCycle(ctx, { url: weatherUrl, log }).catch((err) => log.error("Weather error:", err));
    run();
    weatherTimer = setInterval(run, weatherEveryHours * 3600 * 1000);
  }
  return () => { clearInterval(sendTimer); if (adviceTimer) clearInterval(adviceTimer); if (weatherTimer) clearInterval(weatherTimer); };
}
