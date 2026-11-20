// The HTTP API. createApp() takes its database and content so tests can pass in-memory ones.
import express from "express";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { COUNTIES, findCounty } from "./geo.js";
import { adviceForFarmer } from "./engine.js";
import { cleanFarmerInput, createFarmer, getFarmer, listFarmers, countFarmersByCounty } from "./farmers.js";
import { timingSafeEqual } from "node:crypto";
import { createPestReport, getPestReport, listPestReports, updatePestReport, STATUSES } from "./pestReports.js";
import { listQuestions, answerQuestion, QUESTION_STATUSES } from "./questions.js";
import { listHotspots } from "./hotspots.js";
import { previewBroadcast, sendBroadcast, listBroadcasts } from "./broadcasts.js";
import { listMessages } from "./messaging.js";
import { normalizePhone } from "./geo.js";
import { handleUssd } from "./ussd.js";
import { handleInboundSms } from "./smsInbound.js";

const PROTOTYPE_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "../../../prototype");

const intParam = (v, fallback, max) => {
  const n = Number.parseInt(v, 10);
  return Number.isInteger(n) && n >= 0 ? Math.min(n, max) : fallback;
};

/**
 * Officer-only routes (farmer lists, reports, questions, broadcasts) need
 * "Authorization: Bearer <OFFICER_TOKEN>" when OFFICER_TOKEN is set.
 * Leave it unset on your laptop; ALWAYS set it on any server others can reach.
 * (Proper staff accounts with roles and 2FA come in MVP Sprint 1.)
 */
function officerGuard(token) {
  if (!token) return (req, res, next) => next();
  const expected = Buffer.from(`Bearer ${token}`);
  return (req, res, next) => {
    const given = Buffer.from(req.get("authorization") ?? "");
    if (given.length === expected.length && timingSafeEqual(given, expected)) return next();
    res.status(401).json({ error: "Officer login required" });
  };
}

export function createApp({ db, content, now = () => new Date(), officerToken = process.env.OFFICER_TOKEN }) {
  const ctx = { db, content, now };
  const officer = officerGuard(officerToken);
  const app = express();
  app.use(express.json({ limit: "100kb" }));
  app.use(express.urlencoded({ extended: false, limit: "20kb" })); // USSD/SMS gateways post form data

  // Allow the prototype pages (opened from file:// or another port) to call the API during development.
  app.use((req, res, next) => {
    res.set("Access-Control-Allow-Origin", "*");
    res.set("Access-Control-Allow-Headers", "Content-Type, Authorization");
    res.set("Access-Control-Allow-Methods", "GET,POST,PATCH,OPTIONS");
    if (req.method === "OPTIONS") return res.sendStatus(204);
    next();
  });

  // The clickable prototype, served by the API so the USSD simulator can talk to it:
  // http://localhost:3000/prototype/ussd.html
  app.use("/prototype", express.static(PROTOTYPE_DIR));
  app.get("/", (req, res) => res.redirect("/prototype/ussd.html"));

  app.get("/health", (req, res) => res.json({ ok: true, service: "agriconnect-api", time: now().toISOString() }));

  // ---- Reference data ----
  app.get("/api/counties", (req, res) => res.json(COUNTIES));
  app.get("/api/content/crops", (req, res) =>
    res.json([...content.crops.values()].map(({ id, name, status, stages }) => ({ id, name, status, stages })))
  );
  app.get("/api/content/pests", (req, res) => res.json({ symptoms: content.symptoms, pests: content.pests }));

  // ---- Farmers ----
  app.post("/api/farmers", (req, res) => {
    const farmer = cleanFarmerInput(req.body ?? {}, content);
    try {
      res.status(201).json(createFarmer(db, farmer));
    } catch (err) {
      if (String(err.message).includes("UNIQUE")) return res.status(409).json({ error: "A farmer with this phone number is already registered" });
      throw err;
    }
  });

  app.get("/api/farmers", officer, (req, res) => {
    const county = req.query.county ? findCounty(req.query.county) : undefined;
    if (req.query.county && !county) return res.status(400).json({ error: "Unknown county" });
    res.json(listFarmers(db, { county, limit: intParam(req.query.limit, 100, 500), offset: intParam(req.query.offset, 0, 1e9) }));
  });

  app.get("/api/farmers/:id", officer, (req, res) => {
    const farmer = getFarmer(db, Number(req.params.id));
    if (!farmer) return res.status(404).json({ error: "Farmer not found" });
    res.json(farmer);
  });

  app.get("/api/farmers/:id/advice", officer, (req, res) => {
    const farmer = getFarmer(db, Number(req.params.id));
    if (!farmer) return res.status(404).json({ error: "Farmer not found" });
    res.json({ farmer_id: farmer.id, date: now().toISOString().slice(0, 10), advice: adviceForFarmer(farmer, content, now()) });
  });

  // ---- Pest reports ----
  app.post("/api/pest-reports", (req, res) => res.status(201).json(createPestReport(db, content, req.body ?? {})));

  app.get("/api/pest-reports", officer, (req, res) => {
    const county = req.query.county ? findCounty(req.query.county) : undefined;
    if (req.query.county && !county) return res.status(400).json({ error: "Unknown county" });
    if (req.query.status && !STATUSES.includes(req.query.status)) return res.status(400).json({ error: `status must be one of ${STATUSES.join(", ")}` });
    res.json(listPestReports(db, { county, status: req.query.status, limit: intParam(req.query.limit, 100, 500) }));
  });

  app.get("/api/pest-reports/:id", officer, (req, res) => {
    const report = getPestReport(db, Number(req.params.id));
    if (!report) return res.status(404).json({ error: "Report not found" });
    res.json(report);
  });

  // ---- USSD *347# (telco gateway webhook) ----
  // Body: phoneNumber, text (answers joined by "*"), plus sessionId/serviceCode which we don't need.
  app.post("/ussd", (req, res) => {
    const { phoneNumber, text } = req.body ?? {};
    const reply = handleUssd(ctx, { phoneNumber, text });
    res.type("text/plain").send(`${reply.type} ${reply.text}`);
  });

  // ---- Incoming SMS (telco gateway webhook) ----
  app.post("/sms/inbound", (req, res) => {
    const { from, text } = req.body ?? {};
    const result = handleInboundSms(ctx, { from, text });
    res.status(result.ok ? 200 : 400).json(result);
  });

  // ---- Message log (SMS outbox/inbox; the simulator's SMS inbox reads this) ----
  app.get("/api/messages", officer, (req, res) => {
    const phone = req.query.phone ? normalizePhone(req.query.phone) : undefined;
    if (req.query.phone && !phone) return res.status(400).json({ error: "Invalid phone" });
    res.json(listMessages(db, { phone, limit: intParam(req.query.limit, 50, 500) }));
  });

  // ---- Questions for officers ----
  app.get("/api/questions", officer, (req, res) => {
    const county = req.query.county ? findCounty(req.query.county) : undefined;
    if (req.query.county && !county) return res.status(400).json({ error: "Unknown county" });
    if (req.query.status && !QUESTION_STATUSES.includes(req.query.status)) return res.status(400).json({ error: `status must be one of ${QUESTION_STATUSES.join(", ")}` });
    res.json(listQuestions(db, { county, status: req.query.status, limit: intParam(req.query.limit, 100, 500) }));
  });

  app.patch("/api/pest-reports/:id", officer, (req, res) => {
    const result = updatePestReport(db, content, Number(req.params.id), req.body ?? {});
    if (!result) return res.status(404).json({ error: "Report not found" });
    res.json(result);
  });

  app.patch("/api/questions/:id", officer, (req, res) => {
    const result = answerQuestion(db, Number(req.params.id), req.body ?? {});
    if (!result) return res.status(404).json({ error: "Question not found" });
    res.json(result);
  });

  // ---- Hotspots: 3+ reports of one pest in one county within 7 days ----
  app.get("/api/hotspots", officer, (req, res) => {
    const county = req.query.county ? findCounty(req.query.county) : undefined;
    if (req.query.county && !county) return res.status(400).json({ error: "Unknown county" });
    res.json(listHotspots(db, content, { county, days: intParam(req.query.days, 7, 90) || 7 }));
  });

  // ---- Broadcasts: one advisory to many farmers ----
  app.post("/api/broadcasts/preview", officer, (req, res) => res.json(previewBroadcast(db, content, req.body ?? {})));
  app.post("/api/broadcasts", officer, (req, res) => res.status(201).json(sendBroadcast(db, content, req.body ?? {})));
  app.get("/api/broadcasts", officer, (req, res) => res.json(listBroadcasts(db, { limit: intParam(req.query.limit, 20, 200) })));

  // ---- Stats for the dashboard ----
  app.get("/api/stats", officer, (req, res) => {
    const one = (sql) => db.prepare(sql).get().n;
    const hotspots = listHotspots(db, content);
    res.json({
      farmers: one("SELECT COUNT(*) AS n FROM farmers WHERE opted_out_at IS NULL"),
      farmers_new_30d: one("SELECT COUNT(*) AS n FROM farmers WHERE created_at >= datetime('now', '-30 days')"),
      sms_sent: one("SELECT COUNT(*) AS n FROM message_log WHERE direction = 'out'"),
      pest_reports_7d: one("SELECT COUNT(*) AS n FROM pest_reports WHERE created_at >= datetime('now', '-7 days')"),
      reports_to_check: one("SELECT COUNT(*) AS n FROM pest_reports WHERE status = 'new'"),
      open_questions: one("SELECT COUNT(*) AS n FROM questions WHERE status = 'open'"),
      hotspots: hotspots.length,
      counties_flagged: new Set(hotspots.map((h) => h.county)).size,
      by_county: countFarmersByCounty(db),
      by_channel: db.prepare("SELECT channel, COUNT(*) AS farmers FROM farmers GROUP BY channel ORDER BY farmers DESC").all().map((r) => ({ ...r }))
    });
  });

  app.use((req, res) => res.status(404).json({ error: "Not found" }));

  // Errors: validation problems are 400 with a list; anything else is logged and hidden from the client.
  app.use((err, req, res, next) => {
    if (err.type === "entity.parse.failed") return res.status(400).json({ error: "Body must be valid JSON" });
    if (err.status === 400 && err.errors) return res.status(400).json({ error: "Invalid input", details: err.errors });
    console.error(err);
    res.status(500).json({ error: "Something went wrong" });
  });

  return app;
}
