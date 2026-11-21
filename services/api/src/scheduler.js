// Automatic crop advice + background workers.
//
// Advice rules (blueprint §2 and §6), per farmer and crop:
//   - send the advice when the farmer reaches a NEW stage of the crop calendar;
//   - in a long stage, send a reminder at most every REMINDER_DAYS days;
//   - never more than WEEKLY_CAP advice messages in 7 days per farmer;
//   - never to farmers who said STOP; nothing between seasons.
// Liberia uses GMT all year, so UTC times are local times.
import { runFeedbackJob, feedbackRunDue } from "./fieldTest.js";
import { escalateOverdue } from "./questions.js";
import { applyApprovedTexts } from "./contentEditor.js";
import { adviceForFarmer } from "./engine.js";
import { sendSms, deliverQueued, requeueStuck } from "./messaging.js";
import { getFarmer } from "./farmers.js";
import { refreshWeather, sendWeatherAlerts, getForecast } from "./weather.js";
import { backupDatabase, recordError } from "./ops.js";

export const REMINDER_DAYS = 28;
export const WEEKLY_CAP = 3;
const DAY = 24 * 60 * 60 * 1000;

/**
 * Queue this week's advice for one farmer, following the rules above.
 * Returns one line per crop: { crop, stage, action: "sent" | "recent" | "cap" | "opted_out" | "no_advice" }.
 */
export async function sendAdviceToFarmer(ctx, farmer, { dryRun = false } = {}) {
  const { db, content } = ctx;
  const now = ctx.now();
  const results = [];
  let sentThisWeek = (await db.get("SELECT COUNT(*) AS n FROM advice_sends WHERE farmer_id = ? AND sent_at >= ?",
    farmer.id, new Date(now.getTime() - 7 * DAY).toISOString())).n;

  let forecast; // read once, only if a stage needs it
  for (const advice of adviceForFarmer(farmer, content, now)) {
    const line = { crop: advice.crop, stage: advice.stage };
    if (!advice.message) { results.push({ ...line, action: "no_advice" }); continue; }
    if (farmer.opted_out_at) { results.push({ ...line, action: "opted_out" }); continue; }
    // Rain override: advice marked hold_in_rain (e.g. "harvest and dry your rice") waits while heavy
    // rain is forecast for the farmer's county, and goes out on the first clear day.
    if (content.crops.get(advice.crop)?.stages.find((s) => s.id === advice.stage)?.hold_in_rain) {
      if (forecast === undefined) forecast = await getForecast(db, farmer.county, now);
      if (forecast?.advice.level === "rain") { results.push({ ...line, action: "rain_hold" }); continue; }
    }
    const last = await db.get("SELECT sent_at FROM advice_sends WHERE farmer_id = ? AND crop = ? AND stage = ? ORDER BY sent_at DESC LIMIT 1",
      farmer.id, advice.crop, advice.stage);
    if (last && now - new Date(last.sent_at) < REMINDER_DAYS * DAY) { results.push({ ...line, action: "recent" }); continue; }
    if (sentThisWeek >= WEEKLY_CAP) { results.push({ ...line, action: "cap" }); continue; }

    if (!dryRun) {
      const msg = await sendSms(db, { phone: farmer.phone, farmerId: farmer.id, body: advice.message, kind: "advice" });
      await db.run("INSERT INTO advice_sends (farmer_id, crop, stage, message_id, sent_at) VALUES (?, ?, ?, ?, ?)",
        farmer.id, advice.crop, advice.stage, msg.id ?? null, now.toISOString());
    }
    sentThisWeek++;
    results.push({ ...line, action: "sent" });
  }
  return results;
}

/** Run the advice job for every registered farmer. Returns a summary and records the run. */
export async function runAdviceJob(ctx, { dryRun = false, trigger = "manual" } = {}) {
  const { db } = ctx;
  const summary = { farmers: 0, sent: 0, recent: 0, cap: 0, opted_out: 0, no_advice: 0, rain_hold: 0, dry_run: dryRun };
  const ids = (await db.all("SELECT id FROM farmers ORDER BY id")).map((r) => r.id);
  for (const id of ids) {
    summary.farmers++;
    for (const r of await sendAdviceToFarmer(ctx, await getFarmer(db, id), { dryRun })) summary[r.action]++;
  }
  if (!dryRun) {
    await db.run("INSERT INTO job_runs (job, run_date, trigger, result) VALUES ('advice', ?, ?, ?)",
      ctx.now().toISOString().slice(0, 10), trigger, JSON.stringify(summary));
  }
  return summary;
}

export async function lastJobRuns(db, job = "advice", limit = 5) {
  return (await db.all("SELECT * FROM job_runs WHERE job = ? ORDER BY id DESC LIMIT ?", job, limit))
    .map((r) => ({ ...r, result: r.result ? JSON.parse(r.result) : null }));
}

/** When the daily job runs next (UTC = Liberia time). */
export function nextAdviceRun(now, hour) {
  const next = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), hour, 0, 0));
  if (next <= now) next.setUTCDate(next.getUTCDate() + 1);
  return next;
}

/** True when today's scheduled run is due and has not happened yet. */
export async function adviceRunDue(db, now, hour) {
  if (now.getUTCHours() < hour) return false;
  const today = now.toISOString().slice(0, 10);
  return !(await db.get("SELECT 1 AS x FROM job_runs WHERE job = 'advice' AND trigger = 'schedule' AND run_date = ?", today));
}

/** Refresh all county forecasts, then send rain alerts (only in the daytime, 06:00-19:00 Liberia time). */
export async function weatherCycle(ctx, { fetch, url, log = console } = {}) {
  const r = await refreshWeather(ctx.db, { fetch, url, now: ctx.now() });
  if (r.failed.length) log.warn(`Weather: ${r.updated} counties updated, ${r.failed.length} failed (${r.failed[0]})`);
  const hour = ctx.now().getUTCHours();
  const alerts = hour >= 6 && hour < 19 ? await sendWeatherAlerts(ctx) : [];
  for (const a of alerts) log.log(`Rain alert for ${a.county}: ${a.reach} farmers`);
  return { ...r, alerts };
}

/** True when today's backup is due (after `hour`:00) and has not been made yet. */
export async function backupDue(db, now, hour) {
  if (now.getUTCHours() < hour) return false;
  return !(await db.get("SELECT 1 AS x FROM backups WHERE ok = 1 AND substr(created_at, 1, 10) = ?", now.toISOString().slice(0, 10)));
}

const SEND_BATCH = 100;

/**
 * Start the background workers inside the API process:
 *  - the SMS sender, every `sendEveryMs`
 *  - the daily backup (BACKUP_DIR) and crop advice (SCHEDULER), checked every minute
 *  - the weather refresh, every `weatherEveryHours`
 * Returns stop().
 */
export async function startWorkers(ctx, provider, { adviceHour = 7, sendEveryMs = 2000, scheduler = true, weather = true, weatherEveryHours = 3, weatherUrl, backupDir, backupHour = 2, backupKeep = 14, log = console } = {}) {
  const stuck = await requeueStuck(ctx.db);
  if (stuck) log.log(`Re-queued ${stuck} message(s) that were being sent when the server stopped.`);

  let sending = false;
  const sendTimer = setInterval(async () => {
    if (sending) return;
    sending = true;
    try {
      // Keep sending batch after batch while there is a queue (a big advisory), for up to 30 s,
      // then let the next tick carry on. Small queues go in one batch, as before.
      const total = { sent: 0, retrying: 0, failed: 0 };
      const started = Date.now();
      for (;;) {
        const r = await deliverQueued(ctx.db, provider, { now: ctx.now(), limit: SEND_BATCH });
        for (const k of Object.keys(total)) total[k] += r[k];
        if (r.sent + r.retrying + r.failed < SEND_BATCH || Date.now() - started > 30000) break;
      }
      if (total.sent || total.retrying || total.failed) log.log(`SMS via ${provider.name}: ${total.sent} sent, ${total.retrying} will retry, ${total.failed} failed`);
    } catch (err) {
      await recordError(ctx.db, err, { job: "sms" });
    } finally {
      sending = false;
    }
  }, sendEveryMs);

  // Daily jobs. They are independent: switching advice off never stops backups.
  let dailyTimer = null;
  let dailyRunning = false;
  if (scheduler || backupDir) {
    const check = async () => {
      if (dailyRunning) return;
      dailyRunning = true;
      try {
        if (backupDir && (await backupDue(ctx.db, ctx.now(), backupHour))) {
          const b = await backupDatabase(ctx.db, backupDir, { now: ctx.now(), keep: backupKeep });
          if (b.ok) log.log(`Backup made and checked: ${b.file} (${Math.round(b.bytes / 1024)} KB, ${b.farmers} farmers)`);
          else await recordError(ctx.db, new Error(`Backup check FAILED: ${b.error ?? b.integrity}`), { job: "backup" });
        }
      } catch (err) {
        await recordError(ctx.db, err, { job: "backup" });
      }
      try {
        if (scheduler && (await adviceRunDue(ctx.db, ctx.now(), adviceHour))) {
          const s = await runAdviceJob(ctx, { trigger: "schedule" });
          log.log(`Daily advice: ${s.sent} queued for ${s.farmers} farmers (${s.recent} already had it, ${s.cap} over the weekly limit).`);
        }
        if (scheduler && (await feedbackRunDue(ctx.db, ctx.now(), adviceHour))) {
          const f = await runFeedbackJob(ctx);
          if (f.asked) log.log(`"Did it help?" SMS sent about ${f.asked} pest report(s).`);
        }
        // Texts approved on another server go live here too (checked every minute).
        await applyApprovedTexts(ctx.db, ctx.content);
        if (scheduler) {
          const e = await escalateOverdue(ctx); // checked every minute
          if (e.escalated) log.log(`${e.escalated} question(s) waited over 24 hours: escalated.`);
        }
      } catch (err) {
        await recordError(ctx.db, err, { job: "advice" });
      } finally {
        dailyRunning = false;
      }
    };
    await check();
    dailyTimer = setInterval(check, 60 * 1000);
  }

  let weatherTimer = null;
  if (weather) {
    const run = () => weatherCycle(ctx, { url: weatherUrl, log }).catch((err) => recordError(ctx.db, err, { job: "weather" }));
    run();
    weatherTimer = setInterval(run, weatherEveryHours * 3600 * 1000);
  }
  return () => { clearInterval(sendTimer); if (dailyTimer) clearInterval(dailyTimer); if (weatherTimer) clearInterval(weatherTimer); };
}
