// API for the farmer smartphone app (apps/farmer). Every route except sign-in needs
// the farmer's session token, so farmers can only see and change their own data.
import { normalizePhone } from "./geo.js";
import { requestOtp, verifyOtp, endSession, farmerAuth, AuthError } from "./auth.js";
import { cleanFarmerInput, createFarmer, getFarmer, setLanguage, setOptedOut, ValidationError } from "./farmers.js";
import { adviceForFarmer } from "./engine.js";
import { createPestReport, getPestReport } from "./pestReports.js";
import { createQuestion, getQuestion } from "./questions.js";
import { listHotspots } from "./hotspots.js";
import { sendSms } from "./messaging.js";
import { sendAdviceToFarmer } from "./scheduler.js";
import { getForecast } from "./weather.js";
import { latestPrices } from "./prices.js";

const CLIENT_ID = /^[A-Za-z0-9_-]{8,64}$/;

function cleanClientId(v) {
  if (v === undefined || v === null) return null;
  if (typeof v !== "string" || !CLIENT_ID.test(v)) throw new ValidationError(["client_id: 8-64 letters, digits, - or _"]);
  return v;
}

/** Alerts for the farmer's county: current hotspots + advisories sent to them in the last 30 days. */
function alertsFor(ctx, farmer) {
  const crops = new Set(farmer.crops.map((c) => c.crop));
  const broadcasts = ctx.db
    .prepare("SELECT id, counties, crops, message, created_at FROM broadcasts WHERE created_at >= datetime('now', '-30 days') ORDER BY id DESC LIMIT 50")
    .all()
    .map((b) => ({ ...b, counties: JSON.parse(b.counties), crops: JSON.parse(b.crops) }))
    .filter((b) => (!b.counties.length || b.counties.includes(farmer.county)) && (!b.crops.length || b.crops.some((c) => crops.has(c))))
    .slice(0, 10)
    .map(({ id, message, created_at }) => ({ id, message, created_at }));
  const hotspots = listHotspots(ctx.db, ctx.content, { county: farmer.county }).map(({ pest, pest_name, county, reports, level }) => ({ pest, pest_name, county, reports, level }));
  return { hotspots, broadcasts };
}

export function farmerRoutes(app, ctx, { exposeDevCode = false } = {}) {
  const { db, content } = ctx;
  const auth = farmerAuth(ctx);
  const registered = (req, res, next) => (req.farmer ? next() : res.status(403).json({ error: "Please register first" }));

  // ---- Sign in ----
  app.post("/api/auth/request-code", (req, res) => {
    const phone = normalizePhone(req.body?.phone);
    if (!phone) return res.status(400).json({ error: "Enter a Liberian mobile number" });
    const code = requestOtp(db, phone, ctx.now());
    // In development (SMS_PROVIDER=log) nothing reaches a real phone, so show the code to the developer.
    res.json({ ok: true, phone, ...(exposeDevCode ? { dev_code: code } : {}) });
  });

  app.post("/api/auth/verify", (req, res) => {
    const phone = normalizePhone(req.body?.phone);
    if (!phone) return res.status(400).json({ error: "Enter a Liberian mobile number" });
    const token = verifyOtp(db, phone, String(req.body?.code ?? "").trim(), ctx.now());
    res.json({ token, phone, registered: !!getFarmerByPhoneSafe(phone) });
  });

  app.post("/api/auth/logout", auth, (req, res) => {
    endSession(db, req.token);
    res.json({ ok: true });
  });

  // ---- The farmer's own data ----
  app.get("/api/me", auth, (req, res) => res.json({ phone: req.phone, registered: !!req.farmer, farmer: req.farmer }));

  app.post("/api/me/register", auth, (req, res) => {
    if (req.farmer) return res.status(409).json({ error: "This phone is already registered" });
    const farmer = createFarmer(db, cleanFarmerInput({ ...req.body, phone: req.phone, channel: "app", registered_by: null }, content));
    sendSms(db, {
      phone: farmer.phone, farmerId: farmer.id, kind: "welcome",
      body: `Welcome to AgriConnect! You are registered in ${farmer.county} County. Farm advice is free. Reply STOP to stop. Dial *347# for help.`
    });
    sendAdviceToFarmer(ctx, farmer);
    res.status(201).json({ farmer });
  });

  app.patch("/api/me", auth, registered, (req, res) => {
    if (req.body?.language !== undefined) setLanguage(db, req.farmer.id, req.body.language);
    if (req.body?.sms !== undefined) setOptedOut(db, req.farmer.id, req.body.sms === false);
    res.json({ farmer: getFarmer(db, req.farmer.id) });
  });

  /** Everything the home screen needs in one call, so the app can cache it for offline use. */
  app.get("/api/me/home", auth, registered, (req, res) => {
    const f = req.farmer;
    const reports = db.prepare("SELECT * FROM pest_reports WHERE phone = ? ORDER BY id DESC LIMIT 20").all(f.phone)
      .map((r) => ({ ...r, symptoms: JSON.parse(r.symptoms) }));
    const questions = db.prepare("SELECT id, body, kind, status, answer, created_at, answered_at, client_id FROM questions WHERE phone = ? ORDER BY id DESC LIMIT 20").all(f.phone)
      .map((q) => ({ ...q }));
    res.json({
      farmer: f,
      date: ctx.now().toISOString().slice(0, 10),
      advice: adviceForFarmer(f, content, ctx.now()),
      alerts: alertsFor(ctx, f),
      weather: getForecast(db, f.county, ctx.now()),
      // Prices at the market in the farmer's county (or Red Light, Monrovia, if none).
      prices: latestPrices(ctx, (content.markets.find((m) => m.county === f.county) ?? content.markets[0]).id),
      reports,
      questions
    });
  });

  app.post("/api/me/reports", auth, registered, (req, res) => {
    const clientId = cleanClientId(req.body?.client_id);
    if (clientId) {
      const existing = db.prepare("SELECT id FROM pest_reports WHERE phone = ? AND client_id = ?").get(req.phone, clientId);
      if (existing) return res.status(200).json({ report: getPestReport(db, existing.id), duplicate: true });
    }
    const result = createPestReport(db, content, { phone: req.phone, crop: req.body?.crop, symptoms: req.body?.symptoms, channel: "app" });
    if (clientId) db.prepare("UPDATE pest_reports SET client_id = ? WHERE id = ?").run(clientId, result.report.id);
    res.status(201).json({ ...result, report: getPestReport(db, result.report.id) });
  });

  app.post("/api/me/questions", auth, registered, (req, res) => {
    const clientId = cleanClientId(req.body?.client_id);
    const body = typeof req.body?.body === "string" ? req.body.body.trim().slice(0, 500) : "";
    if (!body) throw new ValidationError(["body: write your question"]);
    if (clientId) {
      const existing = db.prepare("SELECT id FROM questions WHERE phone = ? AND client_id = ?").get(req.phone, clientId);
      if (existing) return res.status(200).json({ question: getQuestion(db, existing.id), duplicate: true });
    }
    const q = createQuestion(db, { farmer: req.farmer, kind: "text", body, channel: "app" });
    if (clientId) db.prepare("UPDATE questions SET client_id = ? WHERE id = ?").run(clientId, q.id);
    res.status(201).json({ question: getQuestion(db, q.id) });
  });

  function getFarmerByPhoneSafe(phone) {
    return db.prepare("SELECT id FROM farmers WHERE phone = ?").get(phone) ?? null;
  }
}

export { AuthError };
