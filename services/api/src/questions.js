// Ask an Expert: questions and call-back requests that go to extension officers.
import { ValidationError } from "./farmers.js";
import { sendSms } from "./messaging.js";
import { sqlNow, sqlDaysAgo } from "./db.js";

export const ANSWER_PREFIX = "AgriConnect officer: ";
export const ANSWER_MAX = 160 - ANSWER_PREFIX.length;

export const QUESTION_KINDS = ["text", "callback", "voice", "photo"];
export const QUESTION_STATUSES = ["open", "answered", "escalated"];

export const ESCALATE_HOURS = 24;
export const PHOTO_MAX_BYTES = 600 * 1024;
const PHOTO_TYPES = ["image/jpeg", "image/png", "image/webp"];

// ---------------------------------------------------------------- routing
/**
 * Pick the officer who should answer: an active officer covering the county, preferring one
 * who covers the farmer's district, then the one with the fewest unanswered questions.
 * Returns a staff id, or null (no officer for that county: admins see it).
 */
export async function pickOfficer(db, { county, district }) {
  if (!county) return null;
  const officers = (await db.all("SELECT id, counties, districts FROM staff WHERE role = 'officer' AND active = 1 ORDER BY id"))
    .filter((o) => JSON.parse(o.counties).includes(county));
  if (!officers.length) return null;
  const d = String(district ?? "").trim().toLowerCase();
  const local = d ? officers.filter((o) => JSON.parse(o.districts ?? "[]").some((x) => x.toLowerCase() === d)) : [];
  const pool = local.length ? local : officers;
  const load = new Map((await db.all(
    `SELECT assigned_to, COUNT(*) AS n FROM questions WHERE status IN ('open', 'escalated') AND assigned_to IN (${pool.map(() => "?").join(",")}) GROUP BY assigned_to`,
    ...pool.map((o) => o.id)
  )).map((r) => [Number(r.assigned_to), Number(r.n)]));
  return pool.reduce((best, o) => ((load.get(o.id) ?? 0) < (load.get(best.id) ?? 0) ? o : best)).id;
}

/** Hand a question to another officer (who must cover its county). */
export async function assignQuestion(db, id, staffId) {
  const q = await getQuestion(db, id);
  if (!q) return null;
  if (staffId !== null) {
    const o = await db.get("SELECT id, role, counties, active FROM staff WHERE id = ?", staffId);
    if (!o || !o.active || !["officer", "admin"].includes(o.role)) throw new ValidationError(["assigned_to: not an active officer"]);
    if (o.role === "officer" && !JSON.parse(o.counties).includes(q.county)) throw new ValidationError([`assigned_to: this officer does not cover ${q.county ?? "questions without a county"}`]);
  }
  await db.run("UPDATE questions SET assigned_to = ? WHERE id = ?", staffId, id);
  return getQuestion(db, id);
}

// ---------------------------------------------------------------- questions
export async function createQuestion(db, { farmer = null, phone, county = null, kind = "text", body = null, channel = "app", clientId = null, photo = null }) {
  const qCounty = farmer?.county ?? county;
  const assigned = await pickOfficer(db, { county: qCounty, district: farmer?.district });
  return db.tx(async (t) => {
    const { id } = await t.get(
      "INSERT INTO questions (farmer_id, phone, channel, body, kind, county, client_id, assigned_to) VALUES (?, ?, ?, ?, ?, ?, ?, ?) RETURNING id",
      farmer?.id ?? null, farmer?.phone ?? phone, channel, body, kind, qCounty, clientId, assigned
    );
    if (photo) await t.run("INSERT INTO question_photos (question_id, mime, data, bytes, created_at) VALUES (?, ?, ?, ?, ?)", id, photo.mime, photo.data, photo.bytes, sqlNow());
    return getQuestion(t, id);
  });
}

/**
 * Check a photo sent as a data URL ("data:image/jpeg;base64,..."). Returns { mime, data, bytes }.
 * The app resizes photos on the phone, so they are small; anything big is refused.
 */
export function cleanPhoto(dataUrl) {
  const m = /^data:(image\/(?:jpeg|png|webp));base64,([A-Za-z0-9+/=]+)$/.exec(String(dataUrl ?? ""));
  if (!m || !PHOTO_TYPES.includes(m[1])) throw new ValidationError(["photo: send a JPEG, PNG or WebP picture"]);
  const bytes = Buffer.from(m[2], "base64");
  if (!bytes.length) throw new ValidationError(["photo: the picture is empty"]);
  if (bytes.length > PHOTO_MAX_BYTES) throw new ValidationError([`photo: too big (${Math.round(bytes.length / 1024)} KB, max ${PHOTO_MAX_BYTES / 1024} KB)`]);
  // Check the file really is the picture type it claims to be.
  const magic = { "image/jpeg": [0xff, 0xd8, 0xff], "image/png": [0x89, 0x50, 0x4e, 0x47], "image/webp": [0x52, 0x49, 0x46, 0x46] }[m[1]];
  if (!magic.every((b, i) => bytes[i] === b)) throw new ValidationError(["photo: the file is not a real picture"]);
  return { mime: m[1], data: bytes.toString("base64"), bytes: bytes.length };
}

export async function getQuestionPhoto(db, questionId) {
  const row = await db.get("SELECT mime, data FROM question_photos WHERE question_id = ?", questionId);
  return row ? { mime: row.mime, bytes: Buffer.from(row.data, "base64") } : null;
}

export async function getQuestion(db, id) {
  const q = await db.get(
    `SELECT q.*, s.name AS assigned_name, EXISTS (SELECT 1 FROM question_photos p WHERE p.question_id = q.id) AS has_photo
       FROM questions q LEFT JOIN staff s ON s.id = q.assigned_to WHERE q.id = ?`, id);
  return q ? { ...q, has_photo: !!Number(q.has_photo) } : null;
}

function filters({ county, counties, status, assignedTo }) {
  const where = [];
  const args = [];
  const list = counties ?? (county ? [county] : null); // counties = an officer's area
  if (list) { where.push(`q.county IN (${list.map(() => "?").join(",") || "NULL"})`); args.push(...list); }
  // "open" means not answered yet, including overdue (escalated) questions.
  if (status === "open") where.push("q.status IN ('open', 'escalated')");
  else if (status) { where.push("q.status = ?"); args.push(status); }
  if (assignedTo !== undefined) { where.push("q.assigned_to = ?"); args.push(assignedTo); }
  return { sql: where.length ? "WHERE " + where.join(" AND ") : "", args };
}

export async function listQuestions(db, { county, counties, status, assignedTo, limit = 100 } = {}) {
  const f = filters({ county, counties, status, assignedTo });
  // Overdue questions first, then the rest, newest first.
  const rows = await db.all(
    `SELECT q.*, s.name AS assigned_name, EXISTS (SELECT 1 FROM question_photos p WHERE p.question_id = q.id) AS has_photo
       FROM questions q LEFT JOIN staff s ON s.id = q.assigned_to ${f.sql}
      ORDER BY CASE q.status WHEN 'escalated' THEN 0 WHEN 'open' THEN 1 ELSE 2 END, q.id DESC LIMIT ?`,
    ...f.args, limit
  );
  return rows.map((q) => ({ ...q, has_photo: !!Number(q.has_photo) }));
}

export async function countQuestions(db, opts = {}) {
  const f = filters(opts);
  return (await db.get(`SELECT COUNT(*) AS n FROM questions q ${f.sql}`, ...f.args)).n;
}

/**
 * Officer answers a question (the farmer gets the answer by SMS) or closes a call-back
 * request after calling (answer is optional: it becomes the officer's note).
 */
export async function answerQuestion(db, id, { answer, answered_by, send_sms = true } = {}) {
  const q = await getQuestion(db, id);
  if (!q) return null;
  const text = typeof answer === "string" ? answer.trim() : "";
  if (q.kind !== "callback" && !text) throw new ValidationError(["answer: write a reply for the farmer"]);
  if (text.length > ANSWER_MAX) throw new ValidationError([`answer: ${text.length} characters (max ${ANSWER_MAX} so it fits in one SMS)`]);
  await db.run("UPDATE questions SET status = 'answered', answer = ?, answered_by = ?, answered_at = ? WHERE id = ?",
    text || null, typeof answered_by === "string" ? answered_by.slice(0, 80) : null, sqlNow(), id);
  let notified = false;
  if (text && send_sms && q.phone) {
    await sendSms(db, { phone: q.phone, farmerId: q.farmer_id, body: ANSWER_PREFIX + text, force: true });
    notified = true;
  }
  return { question: await getQuestion(db, id), notified };
}

// ---------------------------------------------------------------- 24-hour escalation
export const escalationText = (q) =>
  `AgriConnect: Q-${q.id} from ${q.county ?? "a farmer"} has waited over ${ESCALATE_HOURS}h${q.assigned_name ? ` (${q.assigned_name})` : ""}. Please answer it on the dashboard.`.slice(0, 160);
export const FARMER_WAIT_TEXT = (q) =>
  `AgriConnect: we have not forgotten your question Q-${q.id}. A senior officer will answer soon. Thank you for waiting.`;

/**
 * Questions still unanswered ESCALATE_HOURS after they came in become "escalated": they go to the
 * top of the dashboard list, the admins (and the county's officers) with an alert phone get an SMS,
 * and the farmer is told they are not forgotten. Each question is escalated once.
 */
export async function escalateOverdue(ctx) {
  const { db } = ctx;
  const now = ctx.now();
  const overdue = await db.all(
    `SELECT q.*, s.name AS assigned_name FROM questions q LEFT JOIN staff s ON s.id = q.assigned_to
      WHERE q.status = 'open' AND q.created_at <= ? ORDER BY q.id`, sqlDaysAgo(ESCALATE_HOURS / 24, now));
  if (!overdue.length) return { escalated: 0 };
  let escalated = 0;
  const staff = await db.all("SELECT id, role, counties, phone FROM staff WHERE active = 1 AND phone IS NOT NULL AND role IN ('officer', 'admin')");
  for (const q of overdue) {
    // Claim it first, so two servers never escalate the same question twice.
    const claimed = await db.run("UPDATE questions SET status = 'escalated', escalated_at = ? WHERE id = ? AND status = 'open'", sqlNow(now), q.id);
    if (claimed?.changes === 0) continue;
    escalated++;
    const to = staff.filter((s) => s.role === "admin" || (q.county && JSON.parse(s.counties).includes(q.county)));
    for (const s of to) await sendSms(db, { phone: s.phone, body: escalationText(q), kind: "alert", force: true });
    if (q.phone && q.kind !== "callback") await sendSms(db, { phone: q.phone, farmerId: q.farmer_id, body: FARMER_WAIT_TEXT(q), force: true });
  }
  return { escalated };
}
