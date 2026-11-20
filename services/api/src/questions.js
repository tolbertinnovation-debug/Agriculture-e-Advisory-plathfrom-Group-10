// Ask an Expert: questions and call-back requests that go to extension officers.
import { ValidationError } from "./farmers.js";
import { sendSms } from "./messaging.js";

export const ANSWER_PREFIX = "AgriConnect officer: ";
export const ANSWER_MAX = 160 - ANSWER_PREFIX.length;

export const QUESTION_KINDS = ["text", "callback", "voice", "photo"];
export const QUESTION_STATUSES = ["open", "answered", "escalated"];

export function createQuestion(db, { farmer = null, phone, county = null, kind = "text", body = null, channel = "app" }) {
  const { lastInsertRowid } = db
    .prepare("INSERT INTO questions (farmer_id, phone, channel, body, kind, county) VALUES (?, ?, ?, ?, ?, ?)")
    .run(farmer?.id ?? null, farmer?.phone ?? phone, channel, body, kind, farmer?.county ?? county);
  return getQuestion(db, Number(lastInsertRowid));
}

export function getQuestion(db, id) {
  const row = db.prepare("SELECT * FROM questions WHERE id = ?").get(id);
  return row ? { ...row } : null;
}

export function listQuestions(db, { county, counties, status, limit = 100 } = {}) {
  const where = [];
  const args = [];
  const list = counties ?? (county ? [county] : null); // counties = an officer's area
  if (list) { where.push(`county IN (${list.map(() => "?").join(",") || "NULL"})`); args.push(...list); }
  if (status) { where.push("status = ?"); args.push(status); }
  return db
    .prepare(`SELECT * FROM questions ${where.length ? "WHERE " + where.join(" AND ") : ""} ORDER BY id DESC LIMIT ?`)
    .all(...args, limit)
    .map((r) => ({ ...r }));
}

/**
 * Officer answers a question (the farmer gets the answer by SMS) or closes a call-back
 * request after calling (answer is optional: it becomes the officer's note).
 */
export function answerQuestion(db, id, { answer, answered_by, send_sms = true } = {}) {
  const q = getQuestion(db, id);
  if (!q) return null;
  const text = typeof answer === "string" ? answer.trim() : "";
  if (q.kind !== "callback" && !text) throw new ValidationError(["answer: write a reply for the farmer"]);
  if (text.length > ANSWER_MAX) throw new ValidationError([`answer: ${text.length} characters (max ${ANSWER_MAX} so it fits in one SMS)`]);
  db.prepare("UPDATE questions SET status = 'answered', answer = ?, answered_by = ?, answered_at = datetime('now') WHERE id = ?")
    .run(text || null, typeof answered_by === "string" ? answered_by.slice(0, 80) : null, id);
  let notified = false;
  if (text && send_sms && q.phone) {
    sendSms(db, { phone: q.phone, farmerId: q.farmer_id, body: ANSWER_PREFIX + text, force: true });
    notified = true;
  }
  return { question: getQuestion(db, id), notified };
}
