// API for the farmer smartphone app (apps/farmer). Every route except sign-in needs
// the farmer's session token, so farmers can only see and change their own data.
import { normalizePhone } from "./geo.js";
import { requestOtp, verifyOtp, endSession, farmerAuth, AuthError } from "./auth.js";
import { cleanFarmerInput, createFarmer, getFarmer, setLanguage, setOptedOut, ValidationError } from "./farmers.js";
import { adviceForFarmer } from "./engine.js";
import { createPestReport, getPestReport } from "./pestReports.js";
import { createQuestion, getQuestion, cleanPhoto } from "./questions.js";
import { listHotspots } from "./hotspots.js";
import { sendSms } from "./messaging.js";
import { sendAdviceToFarmer } from "./scheduler.js";
import { getForecast } from "./weather.js";
import { latestPrices } from "./prices.js";
import { sqlDaysAgo, isUniqueViolation } from "./db.js";

const CLIENT_ID = /^[A-Za-z0-9_-]{8,64}$/;

function cleanClientId(v) {
  if (v === undefined || v === null) return null;
  if (typeof v !== "string" || !CLIENT_ID.test(v)) throw new ValidationError(["client_id: 8-64 letters, digits, - or _"]);
  return v;
}

/** Alerts for the farmer's county: current hotspots + advisories sent to them in the last 30 days. */
async function alertsFor(ctx, farmer) {
  const crops = new Set(farmer.crops.map((c) => c.crop));
  const broadcasts = (await ctx.db.all("SELECT id, counties, crops, message, created_at FROM broadcasts WHERE created_at >= ? ORDER BY id DESC LIMIT 50", sqlDaysAgo(30)))
    .map((b) => ({ ...b, counties: JSON.parse(b.counties), crops: JSON.parse(b.crops) }))
    .filter((b) => (!b.counties.length || b.counties.includes(farmer.county)) && (!b.crops.length || b.crops.some((c) => crops.has(c))))
    .slice(0, 10)
    .map(({ id, message, created_at }) => ({ id, message, created_at }));
  const hotspots = (await listHotspots(ctx.db, ctx.content, { county: farmer.county })).map(({ pest, pest_name, county, reports, level }) => ({ pest, pest_name, county, reports, level }));
  return { hotspots, broadcasts };
}

export function farmerRoutes(app, ctx, { exposeDevCode = false } = {}) {
  const { db, content } = ctx;
  const auth = farmerAuth(ctx);
  const registered = (req, res, next) => (req.farmer ? next() : res.status(403).json({ error: "Please register first" }));

  // ---- Sign in ----
  app.post("/api/auth/request-code", async (req, res) => {
    const phone = normalizePhone(req.body?.phone);
    if (!phone) return res.status(400).json({ error: "Enter a Liberian mobile number" });
    const code = await requestOtp(db, phone, ctx.now());
    // In development (SMS_PROVIDER=log) nothing reaches a real phone, so show the code to the developer.
    res.json({ ok: true, phone, ...(exposeDevCode ? { dev_code: code } : {}) });
  });

  app.post("/api/auth/verify", async (req, res) => {
    const phone = normalizePhone(req.body?.phone);
    if (!phone) return res.status(400).json({ error: "Enter a Liberian mobile number" });
    const token = await verifyOtp(db, phone, String(req.body?.code ?? "").trim(), ctx.now());
    res.json({ token, phone, registered: !!(await db.get("SELECT id FROM farmers WHERE phone = ?", phone)) });
  });

  app.post("/api/auth/logout", auth, async (req, res) => {
    await endSession(db, req.token);
    res.json({ ok: true });
  });

  // ---- The farmer's own data ----
  app.get("/api/me", auth, (req, res) => res.json({ phone: req.phone, registered: !!req.farmer, farmer: req.farmer }));

  app.post("/api/me/register", auth, async (req, res) => {
    if (req.farmer) return res.status(409).json({ error: "This phone is already registered" });
    let farmer;
    try {
      farmer = await createFarmer(db, cleanFarmerInput({ ...req.body, phone: req.phone, channel: "app", registered_by: null }, content));
    } catch (err) {
      if (isUniqueViolation(err)) return res.status(409).json({ error: "This phone is already registered" });
      throw err;
    }
    await sendSms(db, {
      phone: farmer.phone, farmerId: farmer.id, kind: "welcome",
      body: `Welcome to AgriConnect! You are registered in ${farmer.county} County. Farm advice is free. Reply STOP to stop. Dial *347# for help.`
    });
    await sendAdviceToFarmer(ctx, farmer);
    res.status(201).json({ farmer });
  });

  app.patch("/api/me", auth, registered, async (req, res) => {
    if (req.body?.language !== undefined) await setLanguage(db, req.farmer.id, req.body.language);
    if (req.body?.sms !== undefined) await setOptedOut(db, req.farmer.id, req.body.sms === false);
    res.json({ farmer: await getFarmer(db, req.farmer.id) });
  });

  /** Everything the home screen needs in one call, so the app can cache it for offline use. */
  app.get("/api/me/home", auth, registered, async (req, res) => {
    const f = req.farmer;
    const reports = (await db.all("SELECT * FROM pest_reports WHERE phone = ? ORDER BY id DESC LIMIT 20", f.phone))
      .map((r) => ({ ...r, symptoms: JSON.parse(r.symptoms) }));
    const questions = (await db.all("SELECT id, body, kind, status, answer, created_at, answered_at, client_id, EXISTS (SELECT 1 FROM question_photos p WHERE p.question_id = questions.id) AS has_photo FROM questions WHERE phone = ? ORDER BY id DESC LIMIT 20", f.phone))
      .map((q) => ({ ...q, has_photo: !!Number(q.has_photo), status: q.status === "escalated" ? "open" : q.status }));
    res.json({
      farmer: f,
      date: ctx.now().toISOString().slice(0, 10),
      advice: adviceForFarmer(f, content, ctx.now()),
      alerts: await alertsFor(ctx, f),
      weather: await getForecast(db, f.county, ctx.now()),
      // Prices at the market in the farmer's county (or Red Light, Monrovia, if none).
      prices: await latestPrices(ctx, (content.markets.find((m) => m.county === f.county) ?? content.markets[0]).id),
      reports,
      questions
    });
  });

  // Offline items carry a client_id. It is stored WITH the item (unique per phone), so a retry,
  // even one arriving at the same moment, finds the first copy instead of making a second.
  app.post("/api/me/reports", auth, registered, async (req, res) => {
    const clientId = cleanClientId(req.body?.client_id);
    const existing = async () => {
      const row = clientId && (await db.get("SELECT id FROM pest_reports WHERE phone = ? AND client_id = ?", req.phone, clientId));
      return row ? res.status(200).json({ report: await getPestReport(db, row.id), duplicate: true }) : null;
    };
    if (await existing()) return;
    try {
      const result = await createPestReport(db, content, { phone: req.phone, crop: req.body?.crop, symptoms: req.body?.symptoms, channel: "app", client_id: clientId });
      res.status(201).json(result);
    } catch (err) {
      if (isUniqueViolation(err) && (await existing())) return;
      throw err;
    }
  });

  app.post("/api/me/questions", auth, registered, async (req, res) => {
    const clientId = cleanClientId(req.body?.client_id);
    const body = typeof req.body?.body === "string" ? req.body.body.trim().slice(0, 500) : "";
    // kind: text (default), photo (a picture, with or without words) or callback (please phone me).
    const callback = req.body?.kind === "callback";
    const photo = !callback && req.body?.photo ? cleanPhoto(req.body.photo) : null;
    if (!body && !photo && !callback) throw new ValidationError(["body: write your question or add a photo"]);
    const existing = async () => {
      const row = clientId && (await db.get("SELECT id FROM questions WHERE phone = ? AND client_id = ?", req.phone, clientId));
      return row ? res.status(200).json({ question: await getQuestion(db, row.id), duplicate: true }) : null;
    };
    if (await existing()) return;
    try {
      const q = await createQuestion(db, { farmer: req.farmer, kind: callback ? "callback" : photo ? "photo" : "text", body: body || null, channel: "app", clientId, photo });
      res.status(201).json({ question: q });
    } catch (err) {
      if (isUniqueViolation(err) && (await existing())) return;
      throw err;
    }
  });
}

export { AuthError };
