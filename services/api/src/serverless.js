// AgriConnect on a serverless host (Vercel). The same app as src/server.js, but nothing may run
// between requests, so the background work is done in short bursts instead:
//  - after a request, queued SMS are sent and, at most once a minute, approved texts are reloaded
//    and questions waiting over 24 hours are escalated (Vercel keeps the function alive for this
//    with waitUntil);
//  - once a day, Vercel Cron calls /api/cron/daily: weather, crop advice, "Did it help?", a restore
//    drill and the SMS queue (protected by CRON_SECRET).
// Settings are environment variables, as on a server (see docs/vercel.md).
import express from "express";
import { timingSafeEqual } from "node:crypto";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { openDb } from "./db.js";
import { loadContent, validateContent } from "./content.js";
import { createApp } from "./app.js";
import { applyApprovedTexts } from "./contentEditor.js";
import { providerFromEnv } from "./providers/index.js";
import { drainQueue, minuteJobs, dailyJobs } from "./scheduler.js";
import { recordError } from "./ops.js";
import { waitUntil as vercelWaitUntil } from "@vercel/functions";

const here = dirname(fileURLToPath(import.meta.url));

/** Refuse settings that would leave farmers' data open (the same rules as src/server.js). */
export function checkSettings(env, provider) {
  const fatal = [];
  if (!env.DATABASE_URL) fatal.push("DATABASE_URL is not set: connect a PostgreSQL database (Vercel → Storage → Neon)");
  if (env.STAFF_AUTH === "off") fatal.push("STAFF_AUTH=off is not allowed on a public server");
  if (provider.name !== "log" && !env.WEBHOOK_SECRET) fatal.push("WEBHOOK_SECRET must be set when a real SMS provider is used");
  if (env.DEMO_MODE === "1" && provider.name !== "log") fatal.push("DEMO_MODE=1 is only allowed with SMS_PROVIDER=log");
  return fatal;
}

/**
 * Build the serverless app around an open database. Tests pass their own db, provider and waitUntil.
 * after-response work is throttled per instance: SMS at most every 2 s, the minute jobs every 60 s.
 */
export function createServerlessApp({ db, content, provider, env = process.env, now = () => new Date(), waitUntil = (p) => p, minuteMs = 60000 }) {
  const ctx = { db, content, now };
  const app = createApp({
    db, content, now,
    providerName: provider.name,
    adviceHour: Number(env.ADVICE_HOUR ?? 7),
    require2fa: env.REQUIRE_2FA === "1",
    webhookSecret: env.WEBHOOK_SECRET,
    weatherUrl: env.WEATHER_URL,
    production: true,
    demoMode: env.DEMO_MODE === "1",
    trustProxy: true
  });
  const outer = express();
  outer.disable("x-powered-by");
  outer.set("trust proxy", 1);

  // Once a day from Vercel Cron: it sends "Authorization: Bearer <CRON_SECRET>".
  outer.get("/api/cron/daily", async (req, res) => {
    const secret = env.CRON_SECRET;
    const given = Buffer.from(String(req.get("authorization") ?? ""));
    const expected = Buffer.from(`Bearer ${secret}`);
    if (!secret || given.length !== expected.length || !timingSafeEqual(given, expected)) return res.status(401).json({ error: "Not allowed" });
    const done = await dailyJobs(ctx, provider, {
      adviceHour: Number(env.ADVICE_HOUR ?? 7),
      scheduler: env.SCHEDULER !== "off",
      weather: env.WEATHER !== "off",
      weatherUrl: env.WEATHER_URL
    });
    res.json({ ok: true, done });
  });

  // After each request, finish the small jobs a server would do in the background.
  let lastMinute = 0;
  let draining = null;
  const afterResponse = async () => {
    try {
      if (!draining) draining = drainQueue(ctx, provider, { budgetMs: 8000 }).finally(() => { draining = null; });
      await draining;
      if (Date.now() - lastMinute >= minuteMs) { lastMinute = Date.now(); await minuteJobs(ctx); }
    } catch (err) {
      await recordError(db, err, { job: "after-response" });
    }
  };
  outer.use((req, res, next) => {
    res.on("finish", () => { if (req.path !== "/health" && req.path !== "/ready") waitUntil(afterResponse()); });
    next();
  });
  outer.use(app);
  outer.afterResponse = afterResponse; // for tests
  return outer;
}

// ---------------------------------------------------------------- the real thing (one per instance)
let ready = null;
/** The app for this serverless instance: opened once, reused by every request it serves. */
export function getServerlessApp({ waitUntil = vercelWaitUntil } = {}) {
  ready ??= (async () => {
    const env = process.env;
    const provider = providerFromEnv();
    const fatal = checkSettings(env, provider);
    if (fatal.length) throw Object.assign(new Error("Refusing to start:\n - " + fatal.join("\n - ")), { fatal });
    const content = loadContent(env.CONTENT_DIR ?? resolve(here, "../../../content"));
    const problems = validateContent(content);
    if (problems.length) throw new Error("Content has problems:\n - " + problems.join("\n - "));
    // A small pool: each instance serves one request at a time; Neon's pooled address shares connections.
    const db = await openDb(env.DATABASE_URL, { max: 3 });
    await applyApprovedTexts(db, content);
    return createServerlessApp({ db, content, provider, env, waitUntil });
  })().catch((err) => { ready = null; throw err; }); // try again on the next request
  return ready;
}
