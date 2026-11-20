// The HTTP API. createApp() takes its database and content so tests can pass in-memory ones.
import express from "express";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { timingSafeEqual } from "node:crypto";
import { COUNTIES, findCounty, normalizePhone } from "./geo.js";
import { adviceForFarmer } from "./engine.js";
import { cleanFarmerInput, createFarmer, getFarmer, getFarmerByPhone, listFarmers, countFarmersByCounty } from "./farmers.js";
import { createPestReport, getPestReport, listPestReports, updatePestReport, STATUSES } from "./pestReports.js";
import { listQuestions, answerQuestion, getQuestion, QUESTION_STATUSES } from "./questions.js";
import { listHotspots } from "./hotspots.js";
import { previewBroadcast, sendBroadcast, listBroadcasts } from "./broadcasts.js";
import { listMessages, markDelivery, messageStats } from "./messaging.js";
import { runAdviceJob, lastJobRuns, nextAdviceRun, weatherCycle } from "./scheduler.js";
import { handleUssd } from "./ussd.js";
import { handleInboundSms } from "./smsInbound.js";
import { farmerRoutes } from "./farmerApi.js";
import { getForecast, COUNTY_POINTS } from "./weather.js";
import { recordPrice, latestPrices, allLatestPrices, listFlaggedPrices, setPriceStatus, addReporter, listReporters } from "./prices.js";
import { staffGuards, staffRoutes, scopeCounties, mustCover } from "./staffAuth.js";
import { audit, can } from "./staff.js";
import { securityHeaders, cors, rateLimit } from "./http.js";
import { recordError, systemStatus, recentErrors, backupDatabase, listBackupFiles } from "./ops.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const PROTOTYPE_DIR = resolve(HERE, "../../../prototype");
const FARMER_APP_DIR = resolve(HERE, "../../../apps/farmer");

const intParam = (v, fallback, max) => {
  const n = Number.parseInt(v, 10);
  return Number.isInteger(n) && n >= 0 ? Math.min(n, max) : fallback;
};

/**
 * Webhooks called by the telco / SMS provider (/ussd, /sms/inbound, /sms/status).
 * When WEBHOOK_SECRET is set, the gateway must call ...?secret=<WEBHOOK_SECRET>
 * (or send header X-Webhook-Secret), so nobody else can fake farmer messages.
 */
function webhookGuard(secret) {
  if (!secret) return (req, res, next) => next();
  const expected = Buffer.from(secret);
  return (req, res, next) => {
    const given = Buffer.from(String(req.get("x-webhook-secret") ?? req.query.secret ?? ""));
    if (given.length === expected.length && timingSafeEqual(given, expected)) return next();
    res.status(401).type("text/plain").send("END Not allowed");
  };
}

export function createApp({
  db, content, now = () => new Date(),
  // Staff login for the officer dashboard. Only turn it off for tests or a quick local demo.
  staffAuth = process.env.STAFF_AUTH !== "off",
  require2fa = process.env.REQUIRE_2FA === "1",
  webhookSecret = process.env.WEBHOOK_SECRET,
  adviceHour = Number(process.env.ADVICE_HOUR ?? 7),
  providerName = process.env.SMS_PROVIDER ?? "log",
  weatherFetch = globalThis.fetch,
  weatherUrl = process.env.WEATHER_URL,
  // Deployment settings (see docs/deploy.md)
  production = process.env.NODE_ENV === "production",
  corsOrigins = process.env.CORS_ORIGINS ? process.env.CORS_ORIGINS.split(",").map((s) => s.trim()).filter(Boolean) : production ? [] : "*",
  trustProxy = process.env.TRUST_PROXY === "1",
  backupDir = process.env.BACKUP_DIR,
  backupKeep = Number(process.env.BACKUP_KEEP ?? 14),
  rateLimits = true
}) {
  const ctx = { db, content, now };
  const guards = staffGuards({ db, now, enabled: staffAuth });
  const { staff, need } = guards;
  const gateway = webhookGuard(webhookSecret);
  const app = express();
  app.disable("x-powered-by");
  if (trustProxy) app.set("trust proxy", 1); // behind Caddy / a load balancer: use the real client IP
  app.use(securityHeaders({ https: production }));
  app.use(express.json({ limit: "100kb" }));
  app.use(express.urlencoded({ extended: false, limit: "20kb" })); // USSD/SMS gateways post form data

  // CORS: open in development (pages opened from file://), closed in production unless CORS_ORIGINS is set.
  app.use(cors(corsOrigins));

  // Per-IP limits on sign-in routes (on top of per-account lockouts).
  if (rateLimits) {
    const tenMin = 10 * 60 * 1000;
    app.use("/api/staff/login", rateLimit({ max: 20, windowMs: tenMin, now: () => now().getTime() }));
    app.use("/api/auth/request-code", rateLimit({ max: 10, windowMs: tenMin, now: () => now().getTime() }));
    app.use("/api/auth/verify", rateLimit({ max: 30, windowMs: tenMin, now: () => now().getTime() }));
  }

  // The officer dashboard, staff pages and USSD simulator: http://localhost:3000/prototype/...
  app.use("/prototype", express.static(PROTOTYPE_DIR));
  // The real farmer app (offline-first PWA). It reuses the server's advisory engine
  // for offline pest diagnosis, so the two can never disagree.
  app.get("/app/engine.js", (req, res) => res.type("application/javascript").sendFile(resolve(HERE, "engine.js")));
  app.use("/app", express.static(FARMER_APP_DIR));
  app.get("/", (req, res) => res.redirect("/app/"));

  // Liveness: the process answers. Readiness: the database answers too (used by Docker and uptime monitors).
  app.get("/health", (req, res) => res.json({ ok: true, service: "agriconnect-api", time: now().toISOString() }));
  app.get("/ready", (req, res) => {
    try {
      db.prepare("SELECT 1").get();
      res.json({ ok: true });
    } catch (err) {
      res.status(503).json({ ok: false, error: "database unavailable" });
    }
  });

  // ---- Reference data (public) ----
  app.get("/api/counties", (req, res) => res.json(COUNTIES));
  app.get("/api/content/crops", (req, res) =>
    res.json([...content.crops.values()].map(({ id, name, status, stages }) => ({ id, name, status, stages })))
  );
  app.get("/api/content/pests", (req, res) => res.json({ symptoms: content.symptoms, pests: content.pests, report_crops: content.reportCrops }));

  // ---- Weather (public: forecasts are not personal data) ----
  app.get("/api/weather", (req, res) => {
    if (req.query.county) {
      const county = findCounty(req.query.county);
      if (!county) return res.status(400).json({ error: "Unknown county" });
      return res.json(getForecast(db, county, now()) ?? { county, days: [], advice: null });
    }
    res.json(Object.keys(COUNTY_POINTS).map((c) => getForecast(db, c, now()) ?? { county: c, days: [], advice: null }));
  });

  // ---- Market prices (public read) ----
  app.get("/api/markets", (req, res) => res.json({ markets: content.markets, items: content.items }));
  app.get("/api/prices", (req, res) => {
    if (!req.query.market) return res.json(allLatestPrices(ctx));
    const list = latestPrices(ctx, req.query.market);
    if (!list) return res.status(404).json({ error: "Unknown market" });
    res.json(list);
  });

  // ---- Staff login, accounts, 2-step login, audit log ----
  staffRoutes(app, ctx, guards, { require2fa });

  // ---- Farmers (officers see only their counties) ----
  // Assisted registration by an officer. Farmers register themselves through USSD or the app (/api/me/register).
  app.post("/api/farmers", ...need("farmers:write"), (req, res) => {
    const farmer = cleanFarmerInput({ ...req.body, channel: "assisted" }, content);
    mustCover(req, farmer.county);
    try {
      const created = createFarmer(db, farmer);
      audit(db, req.staff, "farmer.register", created.phone, { county: created.county });
      res.status(201).json(created);
    } catch (err) {
      if (String(err.message).includes("UNIQUE")) return res.status(409).json({ error: "A farmer with this phone number is already registered" });
      throw err;
    }
  });

  app.get("/api/farmers", ...need("farmers:read"), (req, res) => {
    res.json(listFarmers(db, { counties: scopeCounties(req, req.query.county), limit: intParam(req.query.limit, 100, 500), offset: intParam(req.query.offset, 0, 1e9) }));
  });

  const farmerById = (req) => {
    const farmer = getFarmer(db, Number(req.params.id));
    if (farmer) mustCover(req, farmer.county);
    return farmer;
  };
  app.get("/api/farmers/:id", ...need("farmers:read"), (req, res) => {
    const farmer = farmerById(req);
    if (!farmer) return res.status(404).json({ error: "Farmer not found" });
    res.json(farmer);
  });
  app.get("/api/farmers/:id/advice", ...need("farmers:read"), (req, res) => {
    const farmer = farmerById(req);
    if (!farmer) return res.status(404).json({ error: "Farmer not found" });
    res.json({ farmer_id: farmer.id, date: now().toISOString().slice(0, 10), advice: adviceForFarmer(farmer, content, now()) });
  });

  // ---- Pest reports ----
  app.post("/api/pest-reports", ...need("reports:write"), (req, res) => {
    const known = req.body?.phone ? getFarmerByPhone(db, req.body.phone) : null;
    mustCover(req, known?.county ?? findCounty(req.body?.county));
    res.status(201).json(createPestReport(db, content, req.body ?? {}));
  });

  app.get("/api/pest-reports", ...need("reports:read"), (req, res) => {
    if (req.query.status && !STATUSES.includes(req.query.status)) return res.status(400).json({ error: `status must be one of ${STATUSES.join(", ")}` });
    res.json(listPestReports(db, { counties: scopeCounties(req, req.query.county), status: req.query.status, limit: intParam(req.query.limit, 100, 500) }));
  });

  app.get("/api/pest-reports/:id", ...need("reports:read"), (req, res) => {
    const report = getPestReport(db, Number(req.params.id));
    if (!report) return res.status(404).json({ error: "Report not found" });
    mustCover(req, report.county);
    res.json(report);
  });

  app.patch("/api/pest-reports/:id", ...need("reports:write"), (req, res) => {
    const report = getPestReport(db, Number(req.params.id));
    if (!report) return res.status(404).json({ error: "Report not found" });
    mustCover(req, report.county);
    const result = updatePestReport(db, content, report.id, req.body ?? {});
    audit(db, req.staff, `report.${result.report.status}`, `PR-${report.id}`, { confirmed_pest: result.report.confirmed_pest });
    res.json(result);
  });

  // ---- USSD *347# (telco gateway webhook) ----
  // Body: phoneNumber, text (answers joined by "*"), plus sessionId/serviceCode which we don't need.
  app.post("/ussd", gateway, (req, res) => {
    const { phoneNumber, text } = req.body ?? {};
    const reply = handleUssd(ctx, { phoneNumber, text });
    res.type("text/plain").send(`${reply.type} ${reply.text}`);
  });

  // ---- Incoming SMS (telco gateway webhook) ----
  app.post("/sms/inbound", gateway, (req, res) => {
    const { from, text } = req.body ?? {};
    const result = handleInboundSms(ctx, { from, text });
    res.status(result.ok ? 200 : 400).json(result);
  });

  // ---- Delivery reports from the SMS provider ----
  // Accepts { id | messageId, status } (Africa's Talking sends id + status=Success/Failed).
  app.post("/sms/status", gateway, (req, res) => {
    const { id, messageId, status } = req.body ?? {};
    res.json({ ok: true, updated: markDelivery(db, id ?? messageId, status) });
  });

  // ---- Prices: officer / editor tools ----
  app.post("/api/prices", ...need("prices:write"), (req, res) => {
    const price = recordPrice(ctx, { ...req.body, reporter: req.staff.email ?? "officer" });
    audit(db, req.staff, "price.enter", `${price.market}/${price.item}`, { price_lrd: price.price_lrd });
    res.status(201).json(price);
  });
  app.get("/api/prices/flagged", ...need("prices:read"), (req, res) => res.json(listFlaggedPrices(ctx)));
  app.patch("/api/prices/:id", ...need("prices:write"), (req, res) => {
    if (!setPriceStatus(db, Number(req.params.id), req.body?.status)) return res.status(404).json({ error: "Price not found" });
    audit(db, req.staff, `price.${req.body.status}`, String(req.params.id));
    res.json({ ok: true });
  });
  app.get("/api/reporters", ...need("prices:read"), (req, res) => res.json(listReporters(db)));
  app.post("/api/reporters", ...need("reporters:write"), (req, res) => {
    const reporter = addReporter(ctx, req.body ?? {});
    audit(db, req.staff, "reporter.add", reporter.phone, { market: reporter.market });
    res.status(201).json(reporter);
  });

  // ---- Weather: refresh now (also runs every 3 hours by itself) ----
  app.post("/api/jobs/weather/run", ...need("weather:run"), async (req, res) => {
    const result = await weatherCycle(ctx, { fetch: weatherFetch, url: weatherUrl, log: { log() {}, warn() {}, error() {} } });
    audit(db, req.staff, "weather.refresh", null, { updated: result.updated, alerts: result.alerts.length });
    res.json(result);
  });

  // ---- Jobs: the daily advice job ----
  app.get("/api/jobs", ...need("jobs:read"), (req, res) => {
    res.json({
      advice: { hour_utc: adviceHour, next_run: nextAdviceRun(now(), adviceHour).toISOString(), last_runs: lastJobRuns(db, "advice") },
      sms: { provider: providerName, ...messageStats(db) }
    });
  });
  app.post("/api/jobs/advice/run", ...need("jobs:run"), (req, res) => {
    const result = runAdviceJob(ctx, { dryRun: req.body?.dry_run === true, trigger: "manual" });
    if (!result.dry_run) audit(db, req.staff, "advice.run", null, { sent: result.sent });
    res.json(result);
  });

  // ---- Message log ----
  // In development (SMS_PROVIDER=log, nothing reaches real phones) the USSD simulator reads one
  // phone's inbox without logging in. Otherwise only admins can read messages.
  const [mustLogIn, mayReadMessages] = need("messages:read");
  const messagesGuard = (req, res, next) =>
    providerName === "log" && req.query.phone ? next() : mustLogIn(req, res, () => mayReadMessages(req, res, next));
  app.get("/api/messages", messagesGuard, (req, res) => {
    const phone = req.query.phone ? normalizePhone(req.query.phone) : undefined;
    if (req.query.phone && !phone) return res.status(400).json({ error: "Invalid phone" });
    res.json(listMessages(db, { phone, limit: intParam(req.query.limit, 50, 500) }));
  });

  // ---- Questions for officers ----
  app.get("/api/questions", ...need("questions:read"), (req, res) => {
    if (req.query.status && !QUESTION_STATUSES.includes(req.query.status)) return res.status(400).json({ error: `status must be one of ${QUESTION_STATUSES.join(", ")}` });
    res.json(listQuestions(db, { counties: scopeCounties(req, req.query.county), status: req.query.status, limit: intParam(req.query.limit, 100, 500) }));
  });

  app.patch("/api/questions/:id", ...need("questions:write"), (req, res) => {
    const q = getQuestion(db, Number(req.params.id));
    if (!q) return res.status(404).json({ error: "Question not found" });
    mustCover(req, q.county);
    const result = answerQuestion(db, q.id, { ...req.body, answered_by: req.staff.name });
    audit(db, req.staff, q.kind === "callback" ? "question.called" : "question.answer", `Q-${q.id}`);
    res.json(result);
  });

  // ---- Hotspots: 3+ reports of one pest in one county within 7 days ----
  app.get("/api/hotspots", ...need("hotspots:read"), (req, res) => {
    res.json(listHotspots(db, content, { counties: scopeCounties(req, req.query.county), days: intParam(req.query.days, 7, 90) || 7 }));
  });

  // ---- Broadcasts: one advisory to many farmers (officers: only their counties) ----
  const broadcastTarget = (req) => {
    const body = req.body ?? {};
    if (req.staff.role !== "officer") return body;
    const counties = (body.counties ?? []).length ? body.counties.map((c) => findCounty(c) ?? c) : req.staff.counties;
    for (const c of counties) mustCover(req, c);
    return { ...body, counties };
  };
  app.post("/api/broadcasts/preview", ...need("broadcasts:send"), (req, res) => res.json(previewBroadcast(db, content, broadcastTarget(req))));
  app.post("/api/broadcasts", ...need("broadcasts:send"), (req, res) => {
    const b = sendBroadcast(db, content, { ...broadcastTarget(req), sent_by: req.staff.name });
    audit(db, req.staff, "broadcast.send", `B-${b.id}`, { counties: b.counties, crops: b.crops, queued: b.queued, message: b.message });
    res.status(201).json(b);
  });
  app.get("/api/broadcasts", ...need("broadcasts:read"), (req, res) => {
    const list = listBroadcasts(db, { limit: intParam(req.query.limit, 20, 200) });
    const mine = req.staff.role === "officer" ? req.staff.counties : null;
    res.json(mine ? list.filter((b) => !b.counties.length || b.counties.some((c) => mine.includes(c))) : list);
  });

  // ---- Stats for the dashboard (aggregate numbers only; hotspots limited to an officer's area) ----
  app.get("/api/stats", ...need("stats:read"), (req, res) => {
    const one = (sql) => db.prepare(sql).get().n;
    const hotspots = listHotspots(db, content, { counties: req.staff.role === "officer" ? req.staff.counties : undefined });
    res.json({
      farmers: one("SELECT COUNT(*) AS n FROM farmers WHERE opted_out_at IS NULL"),
      farmers_new_30d: one("SELECT COUNT(*) AS n FROM farmers WHERE created_at >= datetime('now', '-30 days')"),
      sms_sent: one("SELECT COUNT(*) AS n FROM message_log WHERE direction = 'out' AND status IN ('sent', 'delivered')"),
      sms: messageStats(db),
      pest_reports_7d: one("SELECT COUNT(*) AS n FROM pest_reports WHERE created_at >= datetime('now', '-7 days')"),
      reports_to_check: listPestReports(db, { counties: req.staff.role === "officer" ? req.staff.counties : undefined, status: "new", limit: 100000 }).length,
      open_questions: listQuestions(db, { counties: req.staff.role === "officer" ? req.staff.counties : undefined, status: "open", limit: 100000 }).length,
      hotspots: hotspots.length,
      counties_flagged: new Set(hotspots.map((h) => h.county)).size,
      by_county: countFarmersByCounty(db),
      by_channel: db.prepare("SELECT channel, COUNT(*) AS farmers FROM farmers GROUP BY channel ORDER BY farmers DESC").all().map((r) => ({ ...r }))
    });
  });

  // ---- Admin: system status, errors, backups ----
  app.get("/api/admin/status", ...need("audit:read"), (req, res) => {
    res.json({ ...systemStatus(db, { now: now(), backupDir, smsProvider: providerName }), recent_errors: recentErrors(db, 10) });
  });
  app.post("/api/admin/backup", ...need("audit:read"), (req, res) => {
    if (!backupDir) return res.status(400).json({ error: "Backups are off: set BACKUP_DIR" });
    const result = backupDatabase(db, backupDir, { now: now(), keep: backupKeep });
    audit(db, req.staff, "backup.run", result.file.split(/[\\/]/).pop(), { ok: result.ok, bytes: result.bytes });
    res.json({ ...result, file: result.file.split(/[\\/]/).pop(), kept: listBackupFiles(backupDir).length });
  });

  farmerRoutes(app, ctx, { exposeDevCode: providerName === "log" });

  app.use((req, res) => res.status(404).json({ error: "Not found" }));

  // Errors: validation problems are 400 with a list; access problems carry their own status;
  // anything else is logged and hidden from the client.
  app.use((err, req, res, next) => {
    if (err.type === "entity.parse.failed") return res.status(400).json({ error: "Body must be valid JSON" });
    if (err.status === 400 && err.errors) return res.status(400).json({ error: "Invalid input", details: err.errors });
    if (err.auth) return res.status(err.status).json({ error: err.message, ...(err.extra ?? {}) });
    recordError(db, err, { method: req.method, path: req.path });
    res.status(500).json({ error: "Something went wrong" });
  });

  return app;
}

export { can };
