// Ask an Expert: questions and call-back requests that go to extension officers.
import { ValidationError } from "./farmers.js";
import { sendSms } from "./messaging.js";
import { sqlNow } from "./db.js";

export const ANSWER_PREFIX = "AgriConnect officer: ";
export const ANSWER_MAX = 160 - ANSWER_PREFIX.length;

export const QUESTION_KINDS = ["text", "callback", "voice", "photo"];
export const QUESTION_STATUSES = ["open", "answered", "escalated"];

export async function createQuestion(db, { farmer = null, phone, county = null, kind = "text", body = null, channel = "app", clientId = null }) {
  const { id } = await db.get(
    "INSERT INTO questions (farmer_id, phone, channel, body, kind, county, client_id) VALUES (?, ?, ?, ?, ?, ?, ?) RETURNING id",
    farmer?.id ?? null, farmer?.phone ?? phone, channel, body, kind, farmer?.county ?? county, clientId
  );
  return getQuestion(db, id);
}

export async function getQuestion(db, id) {
  return (await db.get("SELECT * FROM questions WHERE id = ?", id)) ?? null;
}

function filters({ county, counties, status }) {
  const where = [];
  const args = [];
  const list = counties ?? (county ? [county] : null); // counties = an officer's area
  if (list) { where.push(`county IN (${list.map(() => "?").join(",") || "NULL"})`); args.push(...list); }
  if (status) { where.push("status = ?"); args.push(status); }
  return { sql: where.length ? "WHERE " + where.join(" AND ") : "", args };
}

export async function listQuestions(db, { county, counties, status, limit = 100 } = {}) {
  const f = filters({ county, counties, status });
  return db.all(`SELECT * FROM questions ${f.sql} ORDER BY id DESC LIMIT ?`, ...f.args, limit);
}

export async function countQuestions(db, opts = {}) {
  const f = filters(opts);
  return (await db.get(`SELECT COUNT(*) AS n FROM questions ${f.sql}`, ...f.args)).n;
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
