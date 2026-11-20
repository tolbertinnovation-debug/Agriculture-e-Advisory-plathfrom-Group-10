// Ask an Expert: questions and call-back requests that go to extension officers.

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

export function listQuestions(db, { county, status, limit = 100 } = {}) {
  const where = [];
  const args = [];
  if (county) { where.push("county = ?"); args.push(county); }
  if (status) { where.push("status = ?"); args.push(status); }
  return db
    .prepare(`SELECT * FROM questions ${where.length ? "WHERE " + where.join(" AND ") : ""} ORDER BY id DESC LIMIT ?`)
    .all(...args, limit)
    .map((r) => ({ ...r }));
}
