// The HTTP API. createApp() takes its database and content so tests can pass in-memory ones.
import express from "express";
import { COUNTIES, findCounty } from "./geo.js";
import { adviceForFarmer } from "./engine.js";
import { cleanFarmerInput, createFarmer, getFarmer, listFarmers, countFarmersByCounty } from "./farmers.js";
import { createPestReport, getPestReport, listPestReports, STATUSES } from "./pestReports.js";

const intParam = (v, fallback, max) => {
  const n = Number.parseInt(v, 10);
  return Number.isInteger(n) && n >= 0 ? Math.min(n, max) : fallback;
};

export function createApp({ db, content, now = () => new Date() }) {
  const app = express();
  app.use(express.json({ limit: "100kb" }));

  // Allow the prototype pages (opened from file:// or another port) to call the API during development.
  app.use((req, res, next) => {
    res.set("Access-Control-Allow-Origin", "*");
    res.set("Access-Control-Allow-Headers", "Content-Type");
    res.set("Access-Control-Allow-Methods", "GET,POST,PATCH,OPTIONS");
    if (req.method === "OPTIONS") return res.sendStatus(204);
    next();
  });

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

  app.get("/api/farmers", (req, res) => {
    const county = req.query.county ? findCounty(req.query.county) : undefined;
    if (req.query.county && !county) return res.status(400).json({ error: "Unknown county" });
    res.json(listFarmers(db, { county, limit: intParam(req.query.limit, 100, 500), offset: intParam(req.query.offset, 0, 1e9) }));
  });

  app.get("/api/farmers/:id", (req, res) => {
    const farmer = getFarmer(db, Number(req.params.id));
    if (!farmer) return res.status(404).json({ error: "Farmer not found" });
    res.json(farmer);
  });

  app.get("/api/farmers/:id/advice", (req, res) => {
    const farmer = getFarmer(db, Number(req.params.id));
    if (!farmer) return res.status(404).json({ error: "Farmer not found" });
    res.json({ farmer_id: farmer.id, date: now().toISOString().slice(0, 10), advice: adviceForFarmer(farmer, content, now()) });
  });

  // ---- Pest reports ----
  app.post("/api/pest-reports", (req, res) => res.status(201).json(createPestReport(db, content, req.body ?? {})));

  app.get("/api/pest-reports", (req, res) => {
    const county = req.query.county ? findCounty(req.query.county) : undefined;
    if (req.query.county && !county) return res.status(400).json({ error: "Unknown county" });
    if (req.query.status && !STATUSES.includes(req.query.status)) return res.status(400).json({ error: `status must be one of ${STATUSES.join(", ")}` });
    res.json(listPestReports(db, { county, status: req.query.status, limit: intParam(req.query.limit, 100, 500) }));
  });

  app.get("/api/pest-reports/:id", (req, res) => {
    const report = getPestReport(db, Number(req.params.id));
    if (!report) return res.status(404).json({ error: "Report not found" });
    res.json(report);
  });

  // ---- Stats for the dashboard ----
  app.get("/api/stats", (req, res) => {
    const one = (sql) => db.prepare(sql).get().n;
    res.json({
      farmers: one("SELECT COUNT(*) AS n FROM farmers WHERE opted_out_at IS NULL"),
      pest_reports_7d: one("SELECT COUNT(*) AS n FROM pest_reports WHERE created_at >= datetime('now', '-7 days')"),
      open_questions: one("SELECT COUNT(*) AS n FROM questions WHERE status = 'open'"),
      by_county: countFarmersByCounty(db)
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
