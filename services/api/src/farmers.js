// Farmer data access: shared by the REST API now and the USSD/SMS handlers in step 2.
import { sqlNow } from "./db.js";
import { findCounty, normalizePhone } from "./geo.js";

export class ValidationError extends Error {
  constructor(errors) {
    super(errors.join("; "));
    this.status = 400;
    this.errors = errors;
  }
}

export const LANGUAGES = ["en", "kpe", "bsq", "kss"]; // Liberian English, Kpelle, Bassa, Kissi
export const CHANNELS = ["app", "ussd", "sms", "voice", "assisted"];

/** Check and clean registration input. Throws ValidationError. */
export function cleanFarmerInput(input, content) {
  const errors = [];
  const phone = normalizePhone(input.phone);
  if (!phone) errors.push("phone: not a valid Liberian mobile number");
  const county = findCounty(input.county);
  if (!county) errors.push("county: must be one of Liberia's 15 counties");
  const language = input.language ?? "en";
  if (!LANGUAGES.includes(language)) errors.push(`language: must be one of ${LANGUAGES.join(", ")}`);
  const channel = input.channel ?? "app";
  if (!CHANNELS.includes(channel)) errors.push(`channel: must be one of ${CHANNELS.join(", ")}`);
  if (input.consent !== true) errors.push("consent: the farmer must agree to receive messages (consent: true)");

  const crops = [];
  if (!Array.isArray(input.crops) || input.crops.length === 0) errors.push("crops: list at least one crop");
  else {
    for (const c of input.crops) {
      if (!content.crops.has(c?.crop)) errors.push(`crops: unknown crop "${c?.crop}" (known: ${[...content.crops.keys()].join(", ")})`);
      else if (!Number.isInteger(c.planting_month) || c.planting_month < 1 || c.planting_month > 12) errors.push(`crops: planting_month for ${c.crop} must be 1-12`);
      else if (crops.some((x) => x.crop === c.crop)) errors.push(`crops: ${c.crop} listed twice`);
      else crops.push({ crop: c.crop, planting_month: c.planting_month });
    }
  }
  if (errors.length) throw new ValidationError(errors);

  return {
    phone,
    name: typeof input.name === "string" ? input.name.trim().slice(0, 80) || null : null,
    county,
    district: typeof input.district === "string" ? input.district.trim().slice(0, 80) || null : null,
    language,
    channel,
    registered_by: input.registered_by ? normalizePhone(input.registered_by) : null,
    crops
  };
}

export async function createFarmer(db, farmer) {
  return db.tx(async (t) => {
    const { id } = await t.get(
      `INSERT INTO farmers (phone, name, county, district, language, channel, registered_by, consent_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?) RETURNING id`,
      farmer.phone, farmer.name, farmer.county, farmer.district, farmer.language, farmer.channel, farmer.registered_by, sqlNow()
    );
    for (const c of farmer.crops) await t.run("INSERT INTO farmer_crops (farmer_id, crop, planting_month) VALUES (?, ?, ?)", id, c.crop, c.planting_month);
    return getFarmer(t, id);
  });
}

async function withCrops(db, row) {
  if (!row) return null;
  const crops = await db.all("SELECT crop, planting_month FROM farmer_crops WHERE farmer_id = ? ORDER BY crop", row.id);
  return { ...row, crops };
}

export async function getFarmer(db, id) {
  return withCrops(db, await db.get("SELECT * FROM farmers WHERE id = ?", id));
}

export async function getFarmerByPhone(db, phone) {
  const p = normalizePhone(phone);
  return p ? withCrops(db, await db.get("SELECT * FROM farmers WHERE phone = ?", p)) : null;
}

// ---- Search, history, corrections and export (officer farmer management) ----

export const FARMER_STATUSES = ["active", "opted_out"];

/** WHERE clause shared by the list, the count and the CSV export. */
function farmerFilter({ county, counties, q, crop, status } = {}) {
  const where = [];
  const args = [];
  const list = counties ?? (county ? [county] : null);
  if (list) {
    where.push(`f.county IN (${list.map(() => "?").join(",") || "NULL"})`);
    args.push(...list);
  }
  if (crop) {
    where.push("EXISTS (SELECT 1 FROM farmer_crops c WHERE c.farmer_id = f.id AND c.crop = ?)");
    args.push(crop);
  }
  if (status === "active") where.push("f.opted_out_at IS NULL");
  if (status === "opted_out") where.push("f.opted_out_at IS NOT NULL");
  const text = typeof q === "string" ? q.trim().slice(0, 60) : "";
  if (text) {
    const like = (v) => `%${v.replace(/[\\%_]/g, (c) => "\\" + c)}%`;
    const parts = ["LOWER(COALESCE(f.name, '')) LIKE ? ESCAPE '\\'", "LOWER(COALESCE(f.district, '')) LIKE ? ESCAPE '\\'"];
    args.push(like(text.toLowerCase()), like(text.toLowerCase()));
    // Phone numbers are stored as +231XXXXXXXX: match the digits people type ("0777 123", "777123").
    let digits = text.replace(/\D/g, "");
    if (digits.startsWith("231")) digits = digits.slice(3);
    if (digits.startsWith("0")) digits = digits.slice(1);
    if (digits.length >= 3) { parts.push("f.phone LIKE ?"); args.push(`%${digits}%`); }
    where.push(`(${parts.join(" OR ")})`);
  }
  return { sql: where.length ? `WHERE ${where.join(" AND ")}` : "", args };
}

/**
 * counties: limit to these counties (an officer's area); undefined = all.
 * q: part of a name, district or phone number. crop: grows this crop. status: active | opted_out.
 */
export async function listFarmers(db, { limit = 100, offset = 0, ...filter } = {}) {
  const { sql, args } = farmerFilter(filter);
  const rows = await db.all(`SELECT f.* FROM farmers f ${sql} ORDER BY f.id DESC LIMIT ? OFFSET ?`, ...args, limit, offset);
  return Promise.all(rows.map((r) => withCrops(db, r)));
}

export async function countFarmers(db, filter = {}) {
  const { sql, args } = farmerFilter(filter);
  return Number((await db.get(`SELECT COUNT(*) AS n FROM farmers f ${sql}`, ...args)).n);
}

const RANK = { joined: 1, registration: 2 }; // same second: show the sign-up below what followed it

/** Everything that happened with one farmer, newest first: messages, pest reports, questions, sign-up. */
export async function farmerHistory(db, farmer, { limit = 200 } = {}) {
  const [messages, reports, questions, registrations, advice, edits] = await Promise.all([
    db.all("SELECT id, channel, direction, body, status, kind, created_at FROM message_log WHERE farmer_id = ? OR phone = ? ORDER BY id DESC LIMIT ?", farmer.id, farmer.phone, limit),
    db.all("SELECT id, crop, symptoms, suggested_pest, match_score, confirmed_pest, channel, status, created_at FROM pest_reports WHERE farmer_id = ? OR phone = ? ORDER BY id DESC LIMIT ?", farmer.id, farmer.phone, limit),
    db.all("SELECT id, kind, channel, body, status, answer, answered_by, created_at, answered_at FROM questions WHERE farmer_id = ? OR phone = ? ORDER BY id DESC LIMIT ?", farmer.id, farmer.phone, limit),
    db.all("SELECT id, registrar_name, status, sms_sent, created_at, answered_at FROM registrations WHERE phone = ? ORDER BY id DESC", farmer.phone),
    db.all("SELECT crop, stage, sent_at FROM advice_sends WHERE farmer_id = ? ORDER BY id DESC", farmer.id),
    db.all("SELECT action, staff_email, detail, created_at FROM audit_log WHERE target = ? AND action IN ('farmer.update', 'farmer.self_update') ORDER BY id DESC LIMIT ?", farmer.phone, limit)
  ]);
  const timeline = [
    ...messages.map((m) => ({ type: "message", at: m.created_at, ...m })),
    ...reports.map((r) => ({ type: "pest_report", at: r.created_at, ...r, symptoms: JSON.parse(r.symptoms) })),
    ...questions.map((q) => ({ type: "question", at: q.created_at, ...q })),
    ...registrations.map((r) => ({ type: "registration", at: r.created_at, ...r })),
    ...edits.map((e) => ({ type: "change", at: e.created_at, by: e.action === "farmer.self_update" ? "farmer" : e.staff_email, changes: JSON.parse(e.detail ?? "{}") })),
    { type: "joined", at: farmer.created_at, channel: farmer.channel, registered_by: farmer.registered_by },
    ...(farmer.opted_out_at ? [{ type: "opted_out", at: farmer.opted_out_at }] : [])
  ].sort((a, b) => String(b.at).localeCompare(String(a.at)) || (RANK[a.type] ?? 0) - (RANK[b.type] ?? 0));
  const out = messages.filter((m) => m.direction === "out");
  return {
    farmer,
    summary: {
      sms_out: out.length,
      delivered: out.filter((m) => m.status === "delivered").length,
      failed: out.filter((m) => m.status === "failed").length,
      messages_in: messages.length - out.length,
      pest_reports: reports.length,
      questions: questions.length,
      open_questions: questions.filter((q) => q.status === "open").length,
      advice_stages: advice.map((a) => `${a.crop}:${a.stage}`)
    },
    timeline
  };
}

const EDITABLE = ["name", "district", "county", "language", "crops"];

/**
 * An officer corrects a farmer's details (a misspelt name, the wrong planting month...).
 * The phone number is the farmer's identity and can't be changed here; consent and STOP stay the farmer's own choice.
 * Returns { farmer, changes: { field: [before, after] } }.
 */
export async function updateFarmer(db, content, farmer, patch) {
  const unknown = Object.keys(patch ?? {}).filter((k) => !EDITABLE.includes(k));
  if (unknown.length) throw new ValidationError([`can't change ${unknown.join(", ")} (you can change: ${EDITABLE.join(", ")})`]);
  const merged = { ...farmer, ...patch, consent: true, channel: farmer.channel, registered_by: undefined };
  if (patch.district === "" || patch.district === null) merged.district = undefined;
  if (patch.name === "" || patch.name === null) merged.name = undefined;
  const clean = cleanFarmerInput(merged, content);

  const changes = {};
  for (const k of ["name", "district", "county", "language"]) if ((clean[k] ?? null) !== (farmer[k] ?? null)) changes[k] = [farmer[k] ?? null, clean[k]];
  const cropText = (list) => [...list].sort((a, b) => a.crop.localeCompare(b.crop)).map((c) => `${c.crop}:${c.planting_month}`).join(",");
  if (patch.crops && cropText(clean.crops) !== cropText(farmer.crops)) changes.crops = [cropText(farmer.crops), cropText(clean.crops)];
  if (!Object.keys(changes).length) return { farmer, changes };

  const updated = await db.tx(async (t) => {
    await t.run("UPDATE farmers SET name = ?, district = ?, county = ?, language = ? WHERE id = ?", clean.name, clean.district, clean.county, clean.language, farmer.id);
    if (changes.crops) {
      await t.run("DELETE FROM farmer_crops WHERE farmer_id = ?", farmer.id);
      for (const c of clean.crops) await t.run("INSERT INTO farmer_crops (farmer_id, crop, planting_month) VALUES (?, ?, ?)", farmer.id, c.crop, c.planting_month);
    }
    return getFarmer(t, farmer.id);
  });
  return { farmer: updated, changes };
}

// ---- CSV export for the field-test log ----
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
export const CSV_COLUMNS = [
  "id", "phone", "name", "county", "district", "language", "joined_via", "registered_by", "crops",
  "joined_at", "opted_out_at", "sms_out", "sms_delivered", "sms_failed", "messages_in", "pest_reports", "questions", "last_contact_at"
];

/** One CSV cell. Text that a spreadsheet would run as a formula (=, +, -, @) gets a leading ' so it stays text. */
export function csvCell(v) {
  let s = v === null || v === undefined ? "" : String(v);
  if (/^[=+\-@\t\r]/.test(s)) s = "'" + s;
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export async function exportFarmersCsv(db, filter = {}, { max = 20000 } = {}) {
  const { sql, args } = farmerFilter(filter);
  // Count everything once per phone, then join: fast on both databases (no query per farmer).
  // Messages, reports and questions are all stored with the farmer's phone number.
  const rows = await db.all(
    `SELECT f.*,
       COALESCE(m.sms_out, 0) AS sms_out, COALESCE(m.sms_delivered, 0) AS sms_delivered, COALESCE(m.sms_failed, 0) AS sms_failed,
       COALESCE(m.messages_in, 0) AS messages_in, m.last_contact_at,
       COALESCE(p.n, 0) AS pest_reports, COALESCE(q.n, 0) AS questions
     FROM farmers f
     LEFT JOIN (
       SELECT phone,
              SUM(CASE WHEN direction = 'out' THEN 1 ELSE 0 END) AS sms_out,
              SUM(CASE WHEN direction = 'out' AND status = 'delivered' THEN 1 ELSE 0 END) AS sms_delivered,
              SUM(CASE WHEN direction = 'out' AND status = 'failed' THEN 1 ELSE 0 END) AS sms_failed,
              SUM(CASE WHEN direction = 'in' THEN 1 ELSE 0 END) AS messages_in,
              MAX(CASE WHEN direction = 'in' THEN created_at END) AS last_contact_at
         FROM message_log GROUP BY phone
     ) m ON m.phone = f.phone
     LEFT JOIN (SELECT phone, COUNT(*) AS n FROM pest_reports GROUP BY phone) p ON p.phone = f.phone
     LEFT JOIN (SELECT phone, COUNT(*) AS n FROM questions GROUP BY phone) q ON q.phone = f.phone
     ${sql} ORDER BY f.id LIMIT ?`,
    ...args, max
  );
  const crops = await db.all(`SELECT farmer_id, crop, planting_month FROM farmer_crops WHERE farmer_id IN (SELECT f.id FROM farmers f ${sql}) ORDER BY crop`, ...args);
  const byFarmer = new Map();
  for (const c of crops) byFarmer.set(c.farmer_id, [...(byFarmer.get(c.farmer_id) ?? []), `${c.crop} (${MONTHS[c.planting_month - 1]})`]);
  const lines = [CSV_COLUMNS.join(",")];
  for (const r of rows) {
    const row = { ...r, joined_via: r.channel, crops: (byFarmer.get(r.id) ?? []).join("; "), joined_at: r.created_at };
    lines.push(CSV_COLUMNS.map((c) => csvCell(row[c] === undefined ? "" : typeof row[c] === "bigint" ? Number(row[c]) : row[c])).join(","));
  }
  // The byte-order mark makes Excel open the file as UTF-8 (names with accents stay readable).
  return { csv: "\uFEFF" + lines.join("\r\n") + "\r\n", count: rows.length };
}

export async function countFarmersByCounty(db) {
  return db.all("SELECT county, COUNT(*) AS farmers FROM farmers WHERE opted_out_at IS NULL GROUP BY county ORDER BY farmers DESC, county");
}

export async function setLanguage(db, farmerId, language) {
  if (!LANGUAGES.includes(language)) throw new ValidationError([`language: must be one of ${LANGUAGES.join(", ")}`]);
  await db.run("UPDATE farmers SET language = ? WHERE id = ?", language, farmerId);
  return getFarmer(db, farmerId);
}

/** STOP / START: opted-out farmers get no push messages, but can still use USSD. */
export async function setOptedOut(db, farmerId, optedOut) {
  await db.run("UPDATE farmers SET opted_out_at = ? WHERE id = ?", optedOut ? sqlNow() : null, farmerId);
  return getFarmer(db, farmerId);
}
