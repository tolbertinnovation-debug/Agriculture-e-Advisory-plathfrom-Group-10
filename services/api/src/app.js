// The HTTP API. createApp() takes its database and content so tests can pass in-memory ones.
import { isOn } from "./flags.js";
import express from "express";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { timingSafeEqual } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { COUNTIES, findCounty, normalizePhone } from "./geo.js";
import { adviceForFarmer } from "./engine.js";
import { cleanFarmerInput, createFarmer, getFarmer, getFarmerByPhone, listFarmers, countFarmers, countFarmersByCounty, farmerHistory, updateFarmer, exportFarmersCsv, FARMER_STATUSES } from "./farmers.js";
import { createPestReport, getPestReport, listPestReports, countPestReports, updatePestReport, STATUSES } from "./pestReports.js";
import { listQuestions, countQuestions, answerQuestion, getQuestion, getQuestionPhoto, assignQuestion, QUESTION_STATUSES } from "./questions.js";
import { sqlDaysAgo, isUniqueViolation } from "./db.js";
import { listHotspots, recentHotspotAlerts } from "./hotspots.js";
import { previewBroadcast, sendBroadcast, listBroadcasts } from "./broadcasts.js";
import { listMessages, markDelivery, messageStats } from "./messaging.js";
import { runAdviceJob, lastJobRuns, nextAdviceRun, weatherCycle } from "./scheduler.js";
import { handleUssd } from "./ussd.js";
import { handleInboundSms } from "./smsInbound.js";
import { farmerRoutes } from "./farmerApi.js";
import { getForecast, COUNTY_POINTS } from "./weather.js";
import { recordPrice, latestPrices, allLatestPrices, listFlaggedPrices, setPriceStatus, addReporter, listReporters } from "./prices.js";
import { staffGuards, staffRoutes, scopeCounties, mustCover } from "./staffAuth.js";
import { audit, can, isAreaLimited, AccessError } from "./staff.js";
import { createRegistration, listRegistrations, getRegistration, resendRegistration, cancelRegistration, mayManage } from "./registrations.js";
import { securityHeaders, cors, rateLimit } from "./http.js";
import { pilotReadiness } from "./preflight.js";
import { recordError, systemStatus, recentErrors, backupDatabase, listBackupFiles, restoreDrill } from "./ops.js";
import { signupFunnel, feedbackSummary, runFeedbackJob } from "./fieldTest.js";
import { listContent, draftText, decideDraft, approveAsIs, textHistory } from "./contentEditor.js";

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
  rateLimits = true,
  // DEMO_MODE=1: a public demo with sample data and no real SMS (SMS_PROVIDER=log only). Sign-in codes are
  // shown on screen and the simulator can read any phone's SMS. Never with real farmers: the readiness
  // check blocks the pilot while it is on, and it is refused with a real SMS provider.
  demoMode = isOn(process.env.DEMO_MODE)
}) {
  if (demoMode && providerName !== "log") throw new Error("DEMO_MODE=1 is only allowed with SMS_PROVIDER=log (no real SMS). Turn DEMO_MODE off before connecting an SMS provider.");
  const ctx = { db, content, now };
  // What the readiness check should know about this server's own settings.
  const readinessEnv = { NODE_ENV: production ? "production" : process.env.NODE_ENV, REQUIRE_2FA: require2fa ? "1" : "", SMS_PROVIDER: providerName, WEBHOOK_SECRET: webhookSecret || "", BACKUP_DIR: backupDir || "", DEMO_MODE: demoMode ? "1" : "", HOSTING: process.env.VERCEL ? "vercel" : "" };
  const guards = staffGuards({ db, now, enabled: staffAuth });
  const { staff, need } = guards;
  const gateway = webhookGuard(webhookSecret);
  const app = express();
  app.disable("x-powered-by");
  if (trustProxy) app.set("trust proxy", 1); // behind Caddy / a load balancer: use the real client IP
  app.use(securityHeaders({ https: production }));
  // Bodies are small, except a question from the farmer app with a photo (resized on the phone).
  const smallJson = express.json({ limit: "100kb" });
  const photoJson = express.json({ limit: "1mb" });
  app.use((req, res, next) => (req.path === "/api/me/questions" ? photoJson : smallJson)(req, res, next));
  app.use(express.urlencoded({ extended: false, limit: "20kb" })); // USSD/SMS gateways post form data

  // CORS: open in development (pages opened from file://), closed in production unless CORS_ORIGINS is set.
  app.use(cors(corsOrigins));

  // Per-IP limits on sign-in routes (on top of per-account lockouts).
  if (rateLimits) {
    const tenMin = 10 * 60 * 1000;
    app.use("/api/staff/login", rateLimit({ max: 20, windowMs: tenMin, now: () => now().getTime() }));
    app.use("/api/auth/request-code", rateLimit({ max: 10, windowMs: tenMin, now: () => now().getTime() }));
    app.use("/api/auth/verify", rateLimit({ max: 30, windowMs: tenMin, now: () => now().getTime() }));
    // Farmers: questions (with photos) and pest reports, per signed-in phone (not per IP: many phones
    // share one mobile-network address). Generous for a farmer syncing an offline outbox.
    const perFarmer = rateLimit({ max: 40, windowMs: tenMin, now: () => now().getTime(), key: (req) => req.get("authorization") ?? req.ip, message: "Too many messages. Please wait a few minutes." });
    app.use("/api/me/questions", (req, res, next) => (req.method === "POST" ? perFarmer(req, res, next) : next()));
    app.use("/api/me/reports", (req, res, next) => (req.method === "POST" ? perFarmer(req, res, next) : next()));
  }

  // The officer dashboard, staff pages and USSD simulator: http://localhost:3000/prototype/...
  app.use("/prototype", express.static(PROTOTYPE_DIR));
  // The real farmer app (offline-first PWA). It reuses the server's advisory engine
  // for offline pest diagnosis, so the two can never disagree.
  app.get("/app/engine.js", async (req, res) => res.type("application/javascript").sendFile(resolve(HERE, "engine.js")));
  app.use("/app", express.static(FARMER_APP_DIR));
  // The main address opens the farmer app: farmers are who the platform is for. Its first screen is
  // the one login (log in or sign up by phone), with a link for staff to the officer dashboard.
  app.get("/", async (req, res) => res.redirect("/app/"));

  // Liveness: the process answers. Readiness: the database answers too (used by Docker and uptime monitors).
  app.get("/health", async (req, res) => res.json({ ok: true, service: "agriconnect-api", time: now().toISOString(), ...(demoMode ? { demo: true } : {}) }));
  app.get("/ready", async (req, res) => {
    try {
      await db.get("SELECT 1 AS x");
      res.json({ ok: true });
    } catch (err) {
      res.status(503).json({ ok: false, error: "database unavailable" });
    }
  });

  // ---- Reference data (public) ----
  app.get("/api/counties", async (req, res) => res.json(COUNTIES));
  app.get("/api/content/crops", async (req, res) =>
    res.json([...content.crops.values()].map(({ id, name, status, stages }) => ({ id, name, status, stages })))
  );
  app.get("/api/content/pests", async (req, res) => res.json({ symptoms: content.symptoms, pests: content.pests, report_crops: content.reportCrops }));

  // ---- Weather (public: forecasts are not personal data) ----
  app.get("/api/weather", async (req, res) => {
    if (req.query.county) {
      const county = findCounty(req.query.county);
      if (!county) return res.status(400).json({ error: "Unknown county" });
      return res.json((await getForecast(db, county, now())) ?? { county, days: [], advice: null });
    }
    const all = [];
    for (const c of Object.keys(COUNTY_POINTS)) all.push((await getForecast(db, c, now())) ?? { county: c, days: [], advice: null });
    res.json(all);
  });

  // ---- Market prices (public read) ----
  app.get("/api/markets", async (req, res) => res.json({ markets: content.markets, items: content.items }));
  app.get("/api/prices", async (req, res) => {
    if (!req.query.market) return res.json(await allLatestPrices(ctx));
    const list = await latestPrices(ctx, req.query.market);
    if (!list) return res.status(404).json({ error: "Unknown market" });
    res.json(list);
  });

  // ---- Staff login, accounts, 2-step login, audit log ----
  staffRoutes(app, ctx, guards, { require2fa });

  // ---- Farmers (officers see only their counties) ----
  // Assisted registration by an officer. Farmers register themselves through USSD or the app (/api/me/register).
  app.post("/api/farmers", ...need("farmers:write"), async (req, res) => {
    const farmer = cleanFarmerInput({ ...req.body, channel: "assisted" }, content);
    mustCover(req, farmer.county);
    try {
      const created = await createFarmer(db, farmer);
      await audit(db, req.staff, "farmer.register", created.phone, { county: created.county });
      res.status(201).json(created);
    } catch (err) {
      if (isUniqueViolation(err)) return res.status(409).json({ error: "A farmer with this phone number is already registered" });
      throw err;
    }
  });

  // ---- Assisted sign-up: an officer or lead farmer registers a farmer, who confirms with YES ----
  app.post("/api/registrations", ...need("registrations:create"), async (req, res) => {
    const county = findCounty(req.body?.county);
    if (county) mustCover(req, county);
    const reg = await createRegistration(ctx, req.body ?? {}, req.staff);
    await audit(db, req.staff, "registration.create", reg.phone, { county: reg.county });
    res.status(201).json(reg);
  });
  app.get("/api/registrations", ...need("registrations:read"), async (req, res) => {
    const status = ["waiting", "joined", "refused", "expired", "cancelled"].includes(req.query.status) ? req.query.status : undefined;
    res.json(await listRegistrations(db, req.staff, { status, limit: intParam(req.query.limit, 100, 500) }));
  });
  const ownRegistration = async (req) => {
    const reg = await getRegistration(db, Number(req.params.id));
    if (reg && !mayManage(req.staff, reg)) throw new AccessError("This registration was made by someone else", 403);
    return reg;
  };
  app.post("/api/registrations/:id/resend", ...need("registrations:create"), async (req, res) => {
    if (!(await ownRegistration(req))) return res.status(404).json({ error: "Registration not found" });
    res.json(await resendRegistration(ctx, Number(req.params.id)));
  });
  app.post("/api/registrations/:id/cancel", ...need("registrations:create"), async (req, res) => {
    const reg = await ownRegistration(req);
    if (!reg) return res.status(404).json({ error: "Registration not found" });
    if (!(await cancelRegistration(db, reg.id))) return res.status(400).json({ error: "Only a waiting invitation can be cancelled" });
    await audit(db, req.staff, "registration.cancel", reg.phone);
    res.json({ ok: true });
  });

  // Search: ?q=<name, district or phone>&crop=rice&status=active|opted_out&county=Bong. The total is in X-Total-Count.
  const farmerQuery = (req) => {
    const crop = req.query.crop ? String(req.query.crop) : undefined;
    if (crop && !content.crops.has(crop)) throw new AccessError(`Unknown crop "${crop}"`, 400);
    const status = req.query.status ? String(req.query.status) : undefined;
    if (status && !FARMER_STATUSES.includes(status)) throw new AccessError(`status must be one of ${FARMER_STATUSES.join(", ")}`, 400);
    return { counties: scopeCounties(req, req.query.county), q: req.query.q ? String(req.query.q) : undefined, crop, status };
  };
  app.get("/api/farmers", ...need("farmers:read"), async (req, res) => {
    const filter = farmerQuery(req);
    const [list, total] = await Promise.all([
      listFarmers(db, { ...filter, limit: intParam(req.query.limit, 100, 500), offset: intParam(req.query.offset, 0, 1e9) }),
      countFarmers(db, filter)
    ]);
    res.set("X-Total-Count", String(total)).json(list);
  });

  // CSV list for the field-test log (opens in Excel or Google Sheets). Officers get their counties only.
  app.get("/api/farmers/export.csv", ...need("farmers:export"), async (req, res) => {
    const filter = farmerQuery(req);
    const { csv, count } = await exportFarmersCsv(db, filter);
    await audit(db, req.staff, "farmers.export", null, { count, ...Object.fromEntries(Object.entries(filter).filter(([, v]) => v !== undefined)) });
    res.set("Content-Disposition", `attachment; filename="agriconnect-farmers-${now().toISOString().slice(0, 10)}.csv"`)
      .set("Cache-Control", "no-store")
      .type("text/csv; charset=utf-8").send(csv);
  });

  const farmerById = async (req) => {
    const farmer = await getFarmer(db, Number(req.params.id));
    if (farmer) mustCover(req, farmer.county);
    return farmer;
  };
  app.get("/api/farmers/:id", ...need("farmers:read"), async (req, res) => {
    const farmer = await farmerById(req);
    if (!farmer) return res.status(404).json({ error: "Farmer not found" });
    res.json(farmer);
  });
  // One farmer's full story: messages, pest reports, questions and sign-up, newest first.
  app.get("/api/farmers/:id/history", ...need("farmers:read"), async (req, res) => {
    const farmer = await farmerById(req);
    if (!farmer) return res.status(404).json({ error: "Farmer not found" });
    res.json(await farmerHistory(db, farmer, { limit: intParam(req.query.limit, 200, 1000) }));
  });
  // Correct a farmer's name, district, county, language or crops and planting months.
  app.patch("/api/farmers/:id", ...need("farmers:edit"), async (req, res) => {
    const farmer = await farmerById(req);
    if (!farmer) return res.status(404).json({ error: "Farmer not found" });
    const newCounty = req.body?.county !== undefined ? findCounty(req.body.county) : null;
    if (newCounty) mustCover(req, newCounty); // an officer can't move a farmer out of their own area
    const { farmer: updated, changes } = await updateFarmer(db, content, farmer, req.body ?? {});
    if (Object.keys(changes).length) await audit(db, req.staff, "farmer.update", updated.phone, changes);
    res.json({ ...updated, changes });
  });
  app.get("/api/farmers/:id/advice", ...need("farmers:read"), async (req, res) => {
    const farmer = await farmerById(req);
    if (!farmer) return res.status(404).json({ error: "Farmer not found" });
    res.json({ farmer_id: farmer.id, date: now().toISOString().slice(0, 10), advice: adviceForFarmer(farmer, content, now()) });
  });

  // ---- Pest reports ----
  app.post("/api/pest-reports", ...need("reports:write"), async (req, res) => {
    const known = req.body?.phone ? await getFarmerByPhone(db, req.body.phone) : null;
    mustCover(req, known?.county ?? findCounty(req.body?.county));
    res.status(201).json(await createPestReport(db, content, req.body ?? {}));
  });

  app.get("/api/pest-reports", ...need("reports:read"), async (req, res) => {
    if (req.query.status && !STATUSES.includes(req.query.status)) return res.status(400).json({ error: `status must be one of ${STATUSES.join(", ")}` });
    res.json(await listPestReports(db, { counties: scopeCounties(req, req.query.county), status: req.query.status, limit: intParam(req.query.limit, 100, 500) }));
  });

  app.get("/api/pest-reports/:id", ...need("reports:read"), async (req, res) => {
    const report = await getPestReport(db, Number(req.params.id));
    if (!report) return res.status(404).json({ error: "Report not found" });
    mustCover(req, report.county);
    res.json(report);
  });

  app.patch("/api/pest-reports/:id", ...need("reports:write"), async (req, res) => {
    const report = await getPestReport(db, Number(req.params.id));
    if (!report) return res.status(404).json({ error: "Report not found" });
    mustCover(req, report.county);
    const result = await updatePestReport(db, content, report.id, req.body ?? {});
    await audit(db, req.staff, `report.${result.report.status}`, `PR-${report.id}`, { confirmed_pest: result.report.confirmed_pest });
    res.json(result);
  });

  // ---- USSD *347# (telco gateway webhook) ----
  // Body: phoneNumber, text (answers joined by "*"), plus sessionId/serviceCode which we don't need.
  app.post("/ussd", gateway, async (req, res) => {
    const { phoneNumber, text } = req.body ?? {};
    const reply = await handleUssd(ctx, { phoneNumber, text });
    res.type("text/plain").send(`${reply.type} ${reply.text}`);
  });

  // ---- Incoming SMS (telco gateway webhook) ----
  app.post("/sms/inbound", gateway, async (req, res) => {
    const { from, text } = req.body ?? {};
    const result = await handleInboundSms(ctx, { from, text });
    res.status(result.ok ? 200 : 400).json(result);
  });

  // ---- Delivery reports from the SMS provider ----
  // Accepts { id | messageId, status } (Africa's Talking sends id + status=Success/Failed).
  app.post("/sms/status", gateway, async (req, res) => {
    const { id, messageId, status } = req.body ?? {};
    res.json({ ok: true, updated: await markDelivery(db, id ?? messageId, status) });
  });

  // ---- Prices: officer / editor tools ----
  app.post("/api/prices", ...need("prices:write"), async (req, res) => {
    const price = await recordPrice(ctx, { ...req.body, reporter: req.staff.email ?? "officer" });
    await audit(db, req.staff, "price.enter", `${price.market}/${price.item}`, { price_lrd: price.price_lrd });
    res.status(201).json(price);
  });
  app.get("/api/prices/flagged", ...need("prices:read"), async (req, res) => res.json(await listFlaggedPrices(ctx)));
  app.patch("/api/prices/:id", ...need("prices:write"), async (req, res) => {
    if (!await setPriceStatus(db, Number(req.params.id), req.body?.status)) return res.status(404).json({ error: "Price not found" });
    await audit(db, req.staff, `price.${req.body.status}`, String(req.params.id));
    res.json({ ok: true });
  });
  app.get("/api/reporters", ...need("prices:read"), async (req, res) => res.json(await listReporters(db)));
  app.post("/api/reporters", ...need("reporters:write"), async (req, res) => {
    const reporter = await addReporter(ctx, req.body ?? {});
    await audit(db, req.staff, "reporter.add", reporter.phone, { market: reporter.market });
    res.status(201).json(reporter);
  });

  // ---- Weather: refresh now (also runs every 3 hours by itself) ----
  app.post("/api/jobs/weather/run", ...need("weather:run"), async (req, res) => {
    const result = await weatherCycle(ctx, { fetch: weatherFetch, url: weatherUrl, log: { log() {}, warn() {}, error() {} } });
    await audit(db, req.staff, "weather.refresh", null, { updated: result.updated, alerts: result.alerts.length });
    res.json(result);
  });

  // ---- Jobs: the daily advice job ----
  app.get("/api/jobs", ...need("jobs:read"), async (req, res) => {
    res.json({
      advice: { hour_utc: adviceHour, next_run: nextAdviceRun(now(), adviceHour).toISOString(), last_runs: await lastJobRuns(db, "advice") },
      sms: { provider: providerName, ...(await messageStats(db)) }
    });
  });
  app.post("/api/jobs/advice/run", ...need("jobs:run"), async (req, res) => {
    const result = await runAdviceJob(ctx, { dryRun: req.body?.dry_run === true, trigger: "manual" });
    if (!result.dry_run) await audit(db, req.staff, "advice.run", null, { sent: result.sent });
    res.json(result);
  });

  // ---- Message log ----
  // In development (SMS_PROVIDER=log, nothing reaches real phones) the USSD simulator reads one
  // phone's inbox without logging in. Otherwise only admins can read messages.
  // Never in production: the inbox holds farmers' sign-in codes.
  const demoInbox = providerName === "log" && (!production || demoMode);
  const [mustLogIn, mayReadMessages] = need("messages:read");
  const messagesGuard = (req, res, next) =>
    demoInbox && req.query.phone ? next() : mustLogIn(req, res, () => mayReadMessages(req, res, next));
  app.get("/api/messages", messagesGuard, async (req, res) => {
    const phone = req.query.phone ? normalizePhone(req.query.phone) : undefined;
    if (req.query.phone && !phone) return res.status(400).json({ error: "Invalid phone" });
    res.json(await listMessages(db, { phone, limit: intParam(req.query.limit, 50, 500) }));
  });

  // ---- Questions for officers ----
  app.get("/api/questions", ...need("questions:read"), async (req, res) => {
    if (req.query.status && !QUESTION_STATUSES.includes(req.query.status)) return res.status(400).json({ error: `status must be one of ${QUESTION_STATUSES.join(", ")}` });
    const mine = req.query.mine === "1" && req.staff.id != null ? req.staff.id : undefined; // ?mine=1: only questions assigned to me
    res.json(await listQuestions(db, { counties: scopeCounties(req, req.query.county), status: req.query.status, assignedTo: mine, limit: intParam(req.query.limit, 100, 500) }));
  });

  app.get("/api/questions/:id/photo", ...need("questions:read"), async (req, res) => {
    const q = await getQuestion(db, Number(req.params.id));
    if (!q) return res.status(404).json({ error: "Question not found" });
    mustCover(req, q.county);
    const photo = await getQuestionPhoto(db, q.id);
    if (!photo) return res.status(404).json({ error: "This question has no photo" });
    res.set("Cache-Control", "private, max-age=3600").set("Content-Security-Policy", "default-src 'none'").type(photo.mime).send(photo.bytes);
  });

  // Hand a question to an officer: {staff_id} or {staff_id: "me"}; officers can take questions in their counties.
  app.patch("/api/questions/:id/assign", ...need("questions:write"), async (req, res) => {
    const q = await getQuestion(db, Number(req.params.id));
    if (!q) return res.status(404).json({ error: "Question not found" });
    mustCover(req, q.county);
    const raw = req.body?.staff_id;
    const staffId = raw === "me" ? req.staff.id : raw === null ? null : Number(raw);
    if (staffId !== null && !Number.isInteger(staffId)) return res.status(400).json({ error: "staff_id: a staff id, \"me\" or null" });
    if (isAreaLimited(req.staff) && staffId !== req.staff.id) throw new AccessError("Officers can take a question for themselves; ask an admin to hand it to someone else");
    const updated = await assignQuestion(db, q.id, staffId);
    await audit(db, req.staff, "question.assign", `Q-${q.id}`, { to: updated.assigned_name ?? null });
    res.json(updated);
  });

  app.patch("/api/questions/:id", ...need("questions:write"), async (req, res) => {
    const q = await getQuestion(db, Number(req.params.id));
    if (!q) return res.status(404).json({ error: "Question not found" });
    mustCover(req, q.county);
    const result = await answerQuestion(db, q.id, { ...req.body, answered_by: req.staff.name });
    await audit(db, req.staff, q.kind === "callback" ? "question.called" : "question.answer", `Q-${q.id}`);
    res.json(result);
  });

  // ---- Hotspots: 3+ reports of one pest in one county within 7 days ----
  app.get("/api/hotspots", ...need("hotspots:read"), async (req, res) => {
    res.json(await listHotspots(db, content, { counties: scopeCounties(req, req.query.county), days: intParam(req.query.days, 7, 90) || 7 }));
  });
  // SMS alerts sent to officers when a hotspot appeared or got worse.
  app.get("/api/hotspots/alerts", ...need("hotspots:read"), async (req, res) => {
    res.json(await recentHotspotAlerts(db, { counties: scopeCounties(req, req.query.county), limit: intParam(req.query.limit, 20, 200) }));
  });

  // ---- Broadcasts: one advisory to many farmers (officers: only their counties) ----
  const broadcastTarget = (req) => {
    const body = req.body ?? {};
    if (!isAreaLimited(req.staff)) return body;
    const counties = (body.counties ?? []).length ? body.counties.map((c) => findCounty(c) ?? c) : req.staff.counties;
    for (const c of counties) mustCover(req, c);
    return { ...body, counties };
  };
  app.post("/api/broadcasts/preview", ...need("broadcasts:send"), async (req, res) => res.json(await previewBroadcast(db, content, broadcastTarget(req))));
  app.post("/api/broadcasts", ...need("broadcasts:send"), async (req, res) => {
    const b = await sendBroadcast(db, content, { ...broadcastTarget(req), sent_by: req.staff.name });
    await audit(db, req.staff, "broadcast.send", `B-${b.id}`, { counties: b.counties, crops: b.crops, queued: b.queued, message: b.message });
    res.status(201).json(b);
  });
  app.get("/api/broadcasts", ...need("broadcasts:read"), async (req, res) => {
    const list = await listBroadcasts(db, { limit: intParam(req.query.limit, 20, 200) });
    const mine = isAreaLimited(req.staff) ? req.staff.counties : null;
    res.json(mine ? list.filter((b) => !b.counties.length || b.counties.some((c) => mine.includes(c))) : list);
  });

  // ---- Stats for the dashboard (aggregate numbers only; hotspots limited to an officer's area) ----
  app.get("/api/stats", ...need("stats:read"), async (req, res) => {
    const one = async (sql, ...args) => (await db.get(sql, ...args)).n;
    const area = isAreaLimited(req.staff) ? req.staff.counties : undefined;
    const hotspots = await listHotspots(db, content, { counties: area });
    res.json({
      farmers: await one("SELECT COUNT(*) AS n FROM farmers WHERE opted_out_at IS NULL"),
      farmers_new_30d: await one("SELECT COUNT(*) AS n FROM farmers WHERE created_at >= ?", sqlDaysAgo(30)),
      sms_sent: await one("SELECT COUNT(*) AS n FROM message_log WHERE direction = 'out' AND status IN ('sent', 'delivered')"),
      sms: await messageStats(db),
      pest_reports_7d: await one("SELECT COUNT(*) AS n FROM pest_reports WHERE created_at >= ?", sqlDaysAgo(7)),
      reports_to_check: await countPestReports(db, { counties: area, status: "new" }),
      open_questions: await countQuestions(db, { counties: area, status: "open" }),
      hotspots: hotspots.length,
      counties_flagged: new Set(hotspots.map((h) => h.county)).size,
      by_county: await countFarmersByCounty(db),
      by_channel: await db.all("SELECT channel, COUNT(*) AS farmers FROM farmers GROUP BY channel ORDER BY farmers DESC, channel")
    });
  });

  // ---- Admin: system status, errors, backups ----
  // ---- Content editor: editors draft advice texts, agronomists approve them ----
  app.get("/api/content/texts", ...need("content:read"), async (req, res) => res.json(await listContent(db, content)));
  app.get("/api/content/texts/history", ...need("content:read"), async (req, res) =>
    res.json(await textHistory(db, String(req.query.item ?? ""), String(req.query.lang ?? "en"))));
  app.post("/api/content/texts", ...need("content:edit"), async (req, res) => {
    const d = await draftText(db, content, req.staff, req.body ?? {});
    await audit(db, req.staff, "content.draft", `${d.item}/${d.lang}`, { text: d.text });
    res.status(201).json(d);
  });
  app.post("/api/content/texts/:id/decide", ...need("content:approve"), async (req, res) => {
    const d = await decideDraft(db, content, req.staff, Number(req.params.id), { approve: req.body?.approve === true, note: req.body?.note });
    if (!d) return res.status(404).json({ error: "Draft not found" });
    await audit(db, req.staff, `content.${d.status === "approved" ? "approve" : "reject"}`, `${d.item}/${d.lang}`, { text: d.text, note: d.note });
    res.json(d);
  });
  app.post("/api/content/texts/approve-as-is", ...need("content:approve"), async (req, res) => {
    const d = await approveAsIs(db, content, req.staff, req.body ?? {});
    await audit(db, req.staff, "content.approve", `${d.item}/${d.lang}`, { text: d.text, as_is: true });
    res.status(201).json(d);
  });

  // ---- Field-test measures (MVP exit criteria) ----
  // USSD sign-up completion has no county (people give up before choosing one), so it covers everyone.
  app.get("/api/field-test", ...need("stats:read"), async (req, res) => {
    const days = intParam(req.query.days, 30, 365) || 30;
    res.json({
      days,
      ussd_signup: await signupFunnel(db, { days, now: now() }),
      did_it_help: await feedbackSummary(db, content, { days, now: now(), counties: scopeCounties(req, req.query.county) }),
      content_review: (await listContent(db, content)).progress
    });
  });
  app.post("/api/jobs/feedback/run", ...need("jobs:run"), async (req, res) => {
    const result = await runFeedbackJob(ctx, { dryRun: req.body?.dry_run === true });
    if (!result.dry_run) await audit(db, req.staff, "job.feedback", null, result);
    res.json(result);
  });

  // Pilot readiness: settings, staff, content, backups and field-test health in one list.
  app.get("/api/admin/readiness", ...need("audit:read"), async (req, res) => res.json(await pilotReadiness(db, content, { now: now(), env: { ...process.env, ...readinessEnv } })));
  app.post("/api/admin/restore-drill", ...need("audit:read"), async (req, res) => {
    const r = await restoreDrill(db, { backupDir, now: now() });
    await audit(db, req.staff, "restore.drill", r.file ?? null, { ok: r.ok, rows: r.rows, error: r.error });
    res.json(r);
  });
  app.get("/api/admin/status", ...need("audit:read"), async (req, res) => {
    res.json({ ...(await systemStatus(db, { now: now(), backupDir, smsProvider: providerName })), recent_errors: await recentErrors(db, 10) });
  });
  app.post("/api/admin/backup", ...need("audit:read"), async (req, res) => {
    if (!backupDir) return res.status(400).json({ error: "Backups are off: set BACKUP_DIR" });
    const result = await backupDatabase(db, backupDir, { now: now(), keep: backupKeep });
    await audit(db, req.staff, "backup.run", result.file.split(/[\\/]/).pop(), { ok: result.ok, bytes: result.bytes });
    res.json({ ...result, file: result.file.split(/[\\/]/).pop(), kept: listBackupFiles(backupDir).length });
  });

  // Download a checked backup of the whole database, to keep a copy off the server (Google Drive, a laptop).
  // Works on any host, including Vercel where there is no backup folder.
  app.get("/api/admin/backup/download", ...need("audit:read"), async (req, res) => {
    const dir = mkdtempSync(resolve(tmpdir(), "agri-dl-"));
    try {
      const result = await backupDatabase(db, dir, { now: now(), keep: 1 });
      if (!result.ok) return res.status(500).json({ error: `The backup failed its check: ${result.error ?? result.integrity}` });
      const name = result.file.split(/[\\/]/).pop();
      await audit(db, req.staff, "backup.download", name, { bytes: result.bytes });
      res.set("Cache-Control", "no-store");
      await new Promise((ok, fail) => res.download(result.file, name, (err) => (err ? fail(err) : ok())));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  farmerRoutes(app, ctx, { exposeDevCode: demoInbox }); // the sign-in code on screen: local demo only

  app.use((req, res) => res.status(404).json({ error: "Not found" }));

  // Errors: validation problems are 400 with a list; access problems carry their own status;
  // anything else is logged and hidden from the client.
  app.use(async (err, req, res, next) => {
    if (err.type === "entity.parse.failed") return res.status(400).json({ error: "Body must be valid JSON" });
    if (err.status === 400 && err.errors) return res.status(400).json({ error: "Invalid input", details: err.errors });
    if (err.auth) return res.status(err.status).json({ error: err.message, ...(err.extra ?? {}) });
    await recordError(db, err, { method: req.method, path: req.path }); // never throws
    res.status(500).json({ error: "Something went wrong" });
  });

  return app;
}

export { can };
