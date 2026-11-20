// Database setup. Uses SQLite built into Node.js (no install needed) for development
// and the hackathon. Before the pilot we move to PostgreSQL (see docs/build-plan.md, Sprint 1).
import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS farmers (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  phone         TEXT NOT NULL UNIQUE,
  name          TEXT,
  county        TEXT NOT NULL,
  district      TEXT,
  language      TEXT NOT NULL DEFAULT 'en',
  channel       TEXT NOT NULL DEFAULT 'app',      -- how they registered: app | ussd | sms | assisted
  registered_by TEXT,                              -- lead farmer / officer phone for assisted sign-up
  consent_at    TEXT NOT NULL,
  opted_out_at  TEXT,
  created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS farmer_crops (
  farmer_id      INTEGER NOT NULL REFERENCES farmers(id) ON DELETE CASCADE,
  crop           TEXT NOT NULL,
  planting_month INTEGER NOT NULL CHECK (planting_month BETWEEN 1 AND 12),
  PRIMARY KEY (farmer_id, crop)
);

CREATE TABLE IF NOT EXISTS pest_reports (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  farmer_id      INTEGER REFERENCES farmers(id),
  phone          TEXT,
  crop           TEXT,
  symptoms       TEXT NOT NULL,                    -- JSON array of symptom codes
  suggested_pest TEXT,
  match_score    INTEGER,
  confirmed_pest TEXT,
  county         TEXT,
  district       TEXT,
  channel        TEXT NOT NULL DEFAULT 'app',
  status         TEXT NOT NULL DEFAULT 'new',      -- new | verified | rejected | closed
  created_at     TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS questions (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  farmer_id    INTEGER REFERENCES farmers(id),
  phone        TEXT,
  channel      TEXT NOT NULL DEFAULT 'app',
  body         TEXT,
  kind         TEXT NOT NULL DEFAULT 'text',       -- text | callback | voice | photo
  county       TEXT,
  status       TEXT NOT NULL DEFAULT 'open',       -- open | answered | escalated
  answer       TEXT,
  answered_by  TEXT,
  created_at   TEXT NOT NULL DEFAULT (datetime('now')),
  answered_at  TEXT
);

CREATE TABLE IF NOT EXISTS broadcasts (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  counties   TEXT NOT NULL,                        -- JSON array
  crops      TEXT NOT NULL,                        -- JSON array (empty = all crops)
  channels   TEXT NOT NULL,                        -- JSON array
  message    TEXT NOT NULL,
  sent_by    TEXT,
  reach      INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS message_log (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  farmer_id  INTEGER REFERENCES farmers(id),
  phone      TEXT NOT NULL,
  channel    TEXT NOT NULL,                        -- sms | ussd | voice | app
  direction  TEXT NOT NULL,                        -- in | out
  body       TEXT NOT NULL,
  status     TEXT NOT NULL DEFAULT 'queued',       -- queued | sent | delivered | failed
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_farmers_county ON farmers(county);
CREATE INDEX IF NOT EXISTS idx_reports_county_status ON pest_reports(county, status);
CREATE INDEX IF NOT EXISTS idx_questions_status ON questions(status);
`;

export function openDb(path = ":memory:") {
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec("PRAGMA foreign_keys = ON;");
  db.exec(SCHEMA);
  return db;
}

/** Run fn inside a transaction; roll back if it throws. */
export function transaction(db, fn) {
  db.exec("BEGIN");
  try {
    const result = fn();
    db.exec("COMMIT");
    return result;
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
}
