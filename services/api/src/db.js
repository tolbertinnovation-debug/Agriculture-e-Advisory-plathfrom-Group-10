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
  status     TEXT NOT NULL DEFAULT 'queued',       -- queued | sending | sent | delivered | failed | received
  kind       TEXT NOT NULL DEFAULT 'reply',        -- reply | welcome | advice | broadcast | alert
  attempts   INTEGER NOT NULL DEFAULT 0,
  next_attempt_at TEXT,                            -- when a failed send may be retried
  provider_id TEXT,                                -- the SMS provider's message id (for delivery reports)
  last_error TEXT,
  sent_at    TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Which crop-stage advice each farmer has received, so the daily job never repeats itself.
CREATE TABLE IF NOT EXISTS advice_sends (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  farmer_id  INTEGER NOT NULL REFERENCES farmers(id) ON DELETE CASCADE,
  crop       TEXT NOT NULL,
  stage      TEXT NOT NULL,
  message_id INTEGER REFERENCES message_log(id),
  sent_at    TEXT NOT NULL                         -- ISO time from the engine's clock
);

-- Scheduled and manual job runs (e.g. the daily advice job).
CREATE TABLE IF NOT EXISTS job_runs (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  job         TEXT NOT NULL,
  run_date    TEXT NOT NULL,                       -- YYYY-MM-DD (Liberia time = UTC)
  trigger     TEXT NOT NULL,                       -- schedule | manual
  result      TEXT,                                -- JSON summary
  started_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Farmer app sign-in: one-time codes sent by SMS, then a long-lived session.
CREATE TABLE IF NOT EXISTS otp_codes (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  phone       TEXT NOT NULL,
  code_hash   TEXT NOT NULL,
  attempts    INTEGER NOT NULL DEFAULT 0,
  expires_at  TEXT NOT NULL,
  used_at     TEXT,
  created_at  TEXT NOT NULL                        -- ISO time from the engine's clock
);
CREATE TABLE IF NOT EXISTS farmer_sessions (
  token_hash  TEXT PRIMARY KEY,
  phone       TEXT NOT NULL,
  expires_at  TEXT NOT NULL,
  created_at  TEXT NOT NULL
);

-- Weather: the latest 5-day forecast per county (refreshed every few hours).
CREATE TABLE IF NOT EXISTS weather_forecasts (
  county      TEXT PRIMARY KEY,
  days        TEXT NOT NULL,                       -- JSON: [{date, rain_prob, rain_mm, t_max, t_min, code}]
  fetched_at  TEXT NOT NULL
);
-- Weather alerts sent per county, so farmers are not warned again and again.
CREATE TABLE IF NOT EXISTS weather_alerts (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  county      TEXT NOT NULL,
  message     TEXT NOT NULL,
  reach       INTEGER NOT NULL DEFAULT 0,
  sent_at     TEXT NOT NULL
);

-- Market prices, reported by trusted market reporters.
CREATE TABLE IF NOT EXISTS market_reporters (
  phone       TEXT PRIMARY KEY,
  name        TEXT,
  market      TEXT NOT NULL,                       -- market id from content/markets.json
  active      INTEGER NOT NULL DEFAULT 1,
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS prices (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  market      TEXT NOT NULL,
  item        TEXT NOT NULL,
  price_lrd   REAL NOT NULL,
  reporter    TEXT,                                -- phone, or officer name
  status      TEXT NOT NULL DEFAULT 'ok',          -- ok | flagged (unusual, waits for an officer) | rejected
  reported_at TEXT NOT NULL                        -- ISO time from the engine's clock
);

-- Staff (officer dashboard) accounts, sessions and the audit log.
CREATE TABLE IF NOT EXISTS staff (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  email           TEXT NOT NULL UNIQUE,
  name            TEXT NOT NULL,
  role            TEXT NOT NULL,                   -- admin | officer | editor | viewer
  counties        TEXT NOT NULL DEFAULT '[]',      -- JSON: counties an officer works in
  password_hash   TEXT NOT NULL,
  totp_secret     TEXT,                            -- 2-step login (authenticator app)
  totp_enabled    INTEGER NOT NULL DEFAULT 0,
  totp_last_step  INTEGER,                         -- stops the same code being used twice
  failed_logins   INTEGER NOT NULL DEFAULT 0,
  locked_until    TEXT,
  active          INTEGER NOT NULL DEFAULT 1,
  last_login_at   TEXT,
  created_at      TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS staff_sessions (
  token_hash  TEXT PRIMARY KEY,
  staff_id    INTEGER NOT NULL REFERENCES staff(id) ON DELETE CASCADE,
  mfa_ok      INTEGER NOT NULL DEFAULT 1,          -- 0 = must set up 2-step login before doing anything else
  expires_at  TEXT NOT NULL,
  created_at  TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS audit_log (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  staff_id    INTEGER,
  staff_email TEXT,
  action      TEXT NOT NULL,                       -- e.g. login, broadcast.send, report.verified, staff.create
  target      TEXT,
  detail      TEXT,                                -- JSON
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Operations: backups made (and checked), and unexpected server errors.
CREATE TABLE IF NOT EXISTS backups (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  file        TEXT NOT NULL,
  bytes       INTEGER NOT NULL,
  ok          INTEGER NOT NULL,                    -- 1 = the copy passed its integrity check
  detail      TEXT,
  created_at  TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS error_log (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  message     TEXT NOT NULL,
  stack       TEXT,
  context     TEXT,
  created_at  TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_prices ON prices(market, item, reported_at);
CREATE INDEX IF NOT EXISTS idx_weather_alerts ON weather_alerts(county, sent_at);
CREATE INDEX IF NOT EXISTS idx_otp_phone ON otp_codes(phone, created_at);
CREATE INDEX IF NOT EXISTS idx_farmers_county ON farmers(county);
CREATE INDEX IF NOT EXISTS idx_reports_county_status ON pest_reports(county, status);
CREATE INDEX IF NOT EXISTS idx_questions_status ON questions(status);
CREATE INDEX IF NOT EXISTS idx_advice_sends_farmer ON advice_sends(farmer_id, crop, stage);
CREATE INDEX IF NOT EXISTS idx_job_runs ON job_runs(job, run_date);
`;

// Columns added after the first release. Old databases get them automatically
// (SQLite cannot add them in CREATE TABLE IF NOT EXISTS). Indexes that use them come after.
const ADDED_COLUMNS = {
  message_log: {
    kind: "TEXT NOT NULL DEFAULT 'reply'",
    attempts: "INTEGER NOT NULL DEFAULT 0",
    next_attempt_at: "TEXT",
    provider_id: "TEXT",
    last_error: "TEXT",
    sent_at: "TEXT"
  },
  // Set by the farmer app for reports/questions made offline, so a retried sync never creates duplicates.
  pest_reports: { client_id: "TEXT" },
  questions: { client_id: "TEXT" }
};
const LATE_INDEXES = `
CREATE INDEX IF NOT EXISTS idx_message_queue ON message_log(status, next_attempt_at);
CREATE INDEX IF NOT EXISTS idx_message_provider ON message_log(provider_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_reports_client ON pest_reports(phone, client_id) WHERE client_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_questions_client ON questions(phone, client_id) WHERE client_id IS NOT NULL;
`;

function migrate(db) {
  for (const [table, columns] of Object.entries(ADDED_COLUMNS)) {
    const existing = new Set(db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name));
    for (const [name, type] of Object.entries(columns)) {
      if (!existing.has(name)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${name} ${type}`);
    }
  }
  db.exec(LATE_INDEXES);
}

export function openDb(path = ":memory:") {
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec("PRAGMA foreign_keys = ON;");
  db.exec(SCHEMA);
  migrate(db);
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
