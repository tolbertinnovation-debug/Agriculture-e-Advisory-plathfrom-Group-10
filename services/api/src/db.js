// Database layer: the same async interface on two databases.
//
//   SQLite (built into Node.js)  laptops, tests, small demos. No install.
//   PostgreSQL                   servers and the pilot. Set DATABASE_URL=postgres://…
//
// Interface (every method is async):
//   db.get(sql, ...params)   first row or undefined
//   db.all(sql, ...params)   all rows
//   db.run(sql, ...params)   { changes }
//   db.exec(sql)             run SQL with no parameters (may hold several statements)
//   db.tx(async (t) => …)    a transaction: use `t` (same interface) inside; rolls back on error
//   db.dialect               "sqlite" | "postgres"
//
// Write SQL that both understand: "?" placeholders, "INSERT … RETURNING id" to get a new id,
// and pass times as parameters (sqlNow(), isoAgo()) instead of database time functions.
// Times are stored as TEXT in both databases, so comparisons behave the same everywhere.
import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import pg from "pg";

// ---------------------------------------------------------------- time helpers
const pad = (n) => String(n).padStart(2, "0");
/** "YYYY-MM-DD HH:MM:SS" in UTC (Liberia time): the format of every created_at column. */
export function sqlNow(d = new Date()) {
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}`;
}
/** sqlNow() of a moment `days` ago (for "in the last 7 days" filters on created_at). */
export const sqlDaysAgo = (days, from = new Date()) => sqlNow(new Date(from.getTime() - days * 86400000));

export function isUniqueViolation(err) {
  return err?.code === "23505" || /UNIQUE constraint failed/.test(String(err?.message));
}

// ---------------------------------------------------------------- schema & migrations
// {{ID}} {{NOW}} {{REAL}} are filled in per database.
const SCHEMA_V1 = `
CREATE TABLE IF NOT EXISTS farmers (
  id            {{ID}},
  phone         TEXT NOT NULL UNIQUE,
  name          TEXT,
  county        TEXT NOT NULL,
  district      TEXT,
  language      TEXT NOT NULL DEFAULT 'en',
  channel       TEXT NOT NULL DEFAULT 'app',      -- how they registered: app | ussd | sms | assisted
  registered_by TEXT,                              -- lead farmer / officer phone for assisted sign-up
  consent_at    TEXT NOT NULL,
  opted_out_at  TEXT,
  created_at    TEXT NOT NULL DEFAULT {{NOW}}
);
CREATE TABLE IF NOT EXISTS farmer_crops (
  farmer_id      INTEGER NOT NULL REFERENCES farmers(id) ON DELETE CASCADE,
  crop           TEXT NOT NULL,
  planting_month INTEGER NOT NULL CHECK (planting_month BETWEEN 1 AND 12),
  PRIMARY KEY (farmer_id, crop)
);
CREATE TABLE IF NOT EXISTS pest_reports (
  id             {{ID}},
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
  client_id      TEXT,                             -- set by the farmer app for offline reports (no duplicates)
  created_at     TEXT NOT NULL DEFAULT {{NOW}}
);
CREATE TABLE IF NOT EXISTS questions (
  id           {{ID}},
  farmer_id    INTEGER REFERENCES farmers(id),
  phone        TEXT,
  channel      TEXT NOT NULL DEFAULT 'app',
  body         TEXT,
  kind         TEXT NOT NULL DEFAULT 'text',       -- text | callback | voice | photo
  county       TEXT,
  status       TEXT NOT NULL DEFAULT 'open',       -- open | answered | escalated
  answer       TEXT,
  answered_by  TEXT,
  client_id    TEXT,
  created_at   TEXT NOT NULL DEFAULT {{NOW}},
  answered_at  TEXT
);
CREATE TABLE IF NOT EXISTS broadcasts (
  id         {{ID}},
  counties   TEXT NOT NULL,                        -- JSON array
  crops      TEXT NOT NULL,                        -- JSON array (empty = all crops)
  channels   TEXT NOT NULL,                        -- JSON array
  message    TEXT NOT NULL,
  sent_by    TEXT,
  reach      INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT {{NOW}}
);
CREATE TABLE IF NOT EXISTS message_log (
  id         {{ID}},
  farmer_id  INTEGER REFERENCES farmers(id),
  phone      TEXT NOT NULL,
  channel    TEXT NOT NULL,                        -- sms | ussd | voice | app
  direction  TEXT NOT NULL,                        -- in | out
  body       TEXT NOT NULL,
  status     TEXT NOT NULL DEFAULT 'queued',       -- queued | sending | sent | delivered | failed | received
  kind       TEXT NOT NULL DEFAULT 'reply',        -- reply | welcome | advice | broadcast | alert | weather
  attempts   INTEGER NOT NULL DEFAULT 0,
  next_attempt_at TEXT,                            -- when a failed send may be retried
  provider_id TEXT,                                -- the SMS provider's message id (for delivery reports)
  last_error TEXT,
  sent_at    TEXT,
  created_at TEXT NOT NULL DEFAULT {{NOW}}
);
-- Which crop-stage advice each farmer has received, so the daily job never repeats itself.
CREATE TABLE IF NOT EXISTS advice_sends (
  id         {{ID}},
  farmer_id  INTEGER NOT NULL REFERENCES farmers(id) ON DELETE CASCADE,
  crop       TEXT NOT NULL,
  stage      TEXT NOT NULL,
  message_id INTEGER REFERENCES message_log(id),
  sent_at    TEXT NOT NULL                         -- ISO time from the engine's clock
);
-- Scheduled and manual job runs (e.g. the daily advice job).
CREATE TABLE IF NOT EXISTS job_runs (
  id          {{ID}},
  job         TEXT NOT NULL,
  run_date    TEXT NOT NULL,                       -- YYYY-MM-DD (Liberia time = UTC)
  trigger     TEXT NOT NULL,                       -- schedule | manual
  result      TEXT,                                -- JSON summary
  started_at  TEXT NOT NULL DEFAULT {{NOW}}
);
-- Farmer app sign-in: one-time codes sent by SMS, then a long-lived session.
CREATE TABLE IF NOT EXISTS otp_codes (
  id          {{ID}},
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
CREATE TABLE IF NOT EXISTS weather_alerts (
  id          {{ID}},
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
  created_at  TEXT NOT NULL DEFAULT {{NOW}}
);
CREATE TABLE IF NOT EXISTS prices (
  id          {{ID}},
  market      TEXT NOT NULL,
  item        TEXT NOT NULL,
  price_lrd   {{REAL}} NOT NULL,
  reporter    TEXT,                                -- phone, or officer email
  status      TEXT NOT NULL DEFAULT 'ok',          -- ok | flagged (unusual, waits for an officer) | rejected
  reported_at TEXT NOT NULL                        -- ISO time from the engine's clock
);
-- Staff (officer dashboard) accounts, sessions and the audit log.
CREATE TABLE IF NOT EXISTS staff (
  id              {{ID}},
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
  created_at      TEXT NOT NULL DEFAULT {{NOW}}
);
CREATE TABLE IF NOT EXISTS staff_sessions (
  token_hash  TEXT PRIMARY KEY,
  staff_id    INTEGER NOT NULL REFERENCES staff(id) ON DELETE CASCADE,
  mfa_ok      INTEGER NOT NULL DEFAULT 1,          -- 0 = must set up 2-step login before doing anything else
  expires_at  TEXT NOT NULL,
  created_at  TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS audit_log (
  id          {{ID}},
  staff_id    INTEGER,
  staff_email TEXT,
  action      TEXT NOT NULL,                       -- e.g. login, broadcast.send, report.verified, staff.create
  target      TEXT,
  detail      TEXT,                                -- JSON
  created_at  TEXT NOT NULL DEFAULT {{NOW}}
);
-- Operations: backups made (and checked), and unexpected server errors.
CREATE TABLE IF NOT EXISTS backups (
  id          {{ID}},
  file        TEXT NOT NULL,
  bytes       INTEGER NOT NULL,
  ok          INTEGER NOT NULL,                    -- 1 = the copy passed its check
  detail      TEXT,
  created_at  TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS error_log (
  id          {{ID}},
  message     TEXT NOT NULL,
  stack       TEXT,
  context     TEXT,
  created_at  TEXT NOT NULL
);
`;

const INDEXES_V1 = `
CREATE INDEX IF NOT EXISTS idx_prices ON prices(market, item, reported_at);
CREATE INDEX IF NOT EXISTS idx_weather_alerts ON weather_alerts(county, sent_at);
CREATE INDEX IF NOT EXISTS idx_otp_phone ON otp_codes(phone, created_at);
CREATE INDEX IF NOT EXISTS idx_farmers_county ON farmers(county);
CREATE INDEX IF NOT EXISTS idx_reports_county_status ON pest_reports(county, status);
CREATE INDEX IF NOT EXISTS idx_questions_status ON questions(status);
CREATE INDEX IF NOT EXISTS idx_advice_sends_farmer ON advice_sends(farmer_id, crop, stage);
CREATE INDEX IF NOT EXISTS idx_job_runs ON job_runs(job, run_date);
CREATE INDEX IF NOT EXISTS idx_message_queue ON message_log(status, next_attempt_at);
CREATE INDEX IF NOT EXISTS idx_message_provider ON message_log(provider_id);
CREATE INDEX IF NOT EXISTS idx_message_phone ON message_log(phone);
CREATE UNIQUE INDEX IF NOT EXISTS idx_reports_client ON pest_reports(phone, client_id) WHERE client_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_questions_client ON questions(phone, client_id) WHERE client_id IS NOT NULL;
`;

const DIALECT = {
  sqlite: { ID: "INTEGER PRIMARY KEY AUTOINCREMENT", NOW: "(datetime('now'))", REAL: "REAL" },
  postgres: { ID: "INTEGER GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY", NOW: "(to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS'))", REAL: "DOUBLE PRECISION" }
};
const fill = (sql, dialect) => sql.replace(/\{\{(\w+)\}\}/g, (_, k) => DIALECT[dialect][k]);

// Columns added after the very first SQLite databases were made on laptops. New databases
// already have them; old ones get them here.
const LEGACY_SQLITE_COLUMNS = {
  message_log: { kind: "TEXT NOT NULL DEFAULT 'reply'", attempts: "INTEGER NOT NULL DEFAULT 0", next_attempt_at: "TEXT", provider_id: "TEXT", last_error: "TEXT", sent_at: "TEXT" },
  pest_reports: { client_id: "TEXT" },
  questions: { client_id: "TEXT" }
};

/**
 * Numbered migrations. Each runs once, inside a transaction, and is recorded in
 * schema_migrations. To change the database later, ADD a migration at the end;
 * never edit one that has already run on a server.
 */
export const MIGRATIONS = [
  {
    version: 1,
    name: "initial schema",
    async up(t) {
      await t.exec(fill(SCHEMA_V1, t.dialect));
      if (t.dialect === "sqlite") {
        for (const [table, columns] of Object.entries(LEGACY_SQLITE_COLUMNS)) {
          const existing = new Set((await t.all(`PRAGMA table_info(${table})`)).map((c) => c.name));
          for (const [name, type] of Object.entries(columns)) if (!existing.has(name)) await t.exec(`ALTER TABLE ${table} ADD COLUMN ${name} ${type}`);
        }
      }
      await t.exec(INDEXES_V1);
    }
  },
  {
    version: 2,
    name: "assisted registrations waiting for the farmer's YES",
    async up(t) {
      await t.exec(fill(`
CREATE TABLE IF NOT EXISTS registrations (
  id             {{ID}},
  phone          TEXT NOT NULL,
  details        TEXT NOT NULL,                    -- JSON: name, county, district, language, crops
  county         TEXT NOT NULL,
  registered_by  INTEGER REFERENCES staff(id),     -- the officer or lead farmer
  registrar_name TEXT,
  status         TEXT NOT NULL DEFAULT 'waiting',  -- waiting | joined | refused | expired | cancelled
  sms_sent       INTEGER NOT NULL DEFAULT 1,       -- how many invitations were sent (max 3)
  farmer_id      INTEGER REFERENCES farmers(id),
  created_at     TEXT NOT NULL,
  expires_at     TEXT NOT NULL,
  answered_at    TEXT
);
CREATE INDEX IF NOT EXISTS idx_registrations_phone ON registrations(phone, status);
CREATE INDEX IF NOT EXISTS idx_registrations_county ON registrations(county, status);
`, t.dialect));
    }
  }
];

export async function migrate(db) {
  await db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT NOT NULL)`);
  const done = new Set((await db.all("SELECT version FROM schema_migrations")).map((r) => Number(r.version)));
  const applied = [];
  for (const m of MIGRATIONS) {
    if (done.has(m.version)) continue;
    await db.tx(async (t) => {
      await m.up(t);
      await t.run("INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)", m.version, m.name, sqlNow());
    });
    applied.push(m.version);
  }
  return applied;
}

/** All application tables in an order that respects foreign keys (parents first). */
export const TABLES = [
  "farmers", "farmer_crops", "pest_reports", "questions", "broadcasts", "message_log", "advice_sends", "job_runs",
  "otp_codes", "farmer_sessions", "weather_forecasts", "weather_alerts", "market_reporters", "prices",
  "staff", "staff_sessions", "audit_log", "backups", "error_log", "registrations"
];

// ---------------------------------------------------------------- SQLite
const plain = (row) => (row ? { ...row } : undefined);

class SqliteHandle {
  constructor(raw) { this.raw = raw; this.dialect = "sqlite"; }
  async get(sql, ...p) { return plain(this.raw.prepare(sql).get(...p)); }
  async all(sql, ...p) { return this.raw.prepare(sql).all(...p).map(plain); }
  async run(sql, ...p) { const r = this.raw.prepare(sql).run(...p); return { changes: Number(r.changes) }; }
  async exec(sql) { this.raw.exec(sql); }
  async tx(fn) { return fn(this); } // already inside a transaction
}

/**
 * SQLite has one connection, so while a transaction is open (across awaits),
 * other callers wait for it to finish instead of slipping their statements into it.
 */
class SqliteDb extends SqliteHandle {
  constructor(raw) { super(raw); this.busy = null; }
  // The "while" checks run right after each wake-up, with no await in between check and use,
  // so two callers can never both see "free" and start transactions at the same time.
  async get(sql, ...p) { while (this.busy) await this.busy; return super.get(sql, ...p); }
  async all(sql, ...p) { while (this.busy) await this.busy; return super.all(sql, ...p); }
  async run(sql, ...p) { while (this.busy) await this.busy; return super.run(sql, ...p); }
  async exec(sql) { while (this.busy) await this.busy; return super.exec(sql); }
  async tx(fn) {
    while (this.busy) await this.busy;
    let release;
    this.busy = new Promise((r) => (release = r));
    this.raw.exec("BEGIN");
    try {
      const result = await fn(new SqliteHandle(this.raw));
      this.raw.exec("COMMIT");
      return result;
    } catch (err) {
      this.raw.exec("ROLLBACK");
      throw err;
    } finally {
      this.busy = null;
      release();
    }
  }
  async close() { this.raw.close(); }
}

// ---------------------------------------------------------------- PostgreSQL
// COUNT(*) is a 64-bit integer and AVG/SUM may be NUMERIC: read them as JS numbers.
pg.types.setTypeParser(20, (v) => (v === null ? null : Number(v)));
pg.types.setTypeParser(1700, (v) => (v === null ? null : Number(v)));

/** "?" placeholders → "$1, $2 …" (ignores "?" inside quoted strings). */
export function toPgParams(sql) {
  let n = 0, out = "", quoted = false;
  for (const ch of sql) {
    if (ch === "'") quoted = !quoted;
    out += ch === "?" && !quoted ? `$${++n}` : ch;
  }
  return out;
}

class PgHandle {
  constructor(client) { this.client = client; this.dialect = "postgres"; }
  async query(sql, p) { return this.client.query(toPgParams(sql), p); }
  async get(sql, ...p) { return (await this.query(sql, p)).rows[0]; }
  async all(sql, ...p) { return (await this.query(sql, p)).rows; }
  async run(sql, ...p) { return { changes: (await this.query(sql, p)).rowCount ?? 0 }; }
  async exec(sql) { await this.client.query(sql); }
  async tx(fn) { return fn(this); }
}

class PgDb extends PgHandle {
  constructor(pool) { super(pool); this.pool = pool; }
  async tx(fn) {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const result = await fn(new PgHandle(client));
      await client.query("COMMIT");
      return result;
    } catch (err) {
      await client.query("ROLLBACK").catch(() => {});
      throw err;
    } finally {
      client.release();
    }
  }
  async close() { await this.pool.end(); }
}

// ---------------------------------------------------------------- open
/**
 * Open a database and bring its schema up to date.
 *   openDb(":memory:")                     SQLite in memory (tests)
 *   openDb("/path/agriconnect.db")         SQLite file
 *   openDb("postgres://user:pw@host/db")   PostgreSQL
 * Options (PostgreSQL): { schema } use a separate schema (tests), { max } pool size.
 */
export async function openDb(target = ":memory:", { schema, max = 10 } = {}) {
  let db;
  if (/^postgres(ql)?:\/\//.test(target)) {
    if (schema) {
      const setup = new pg.Client({ connectionString: target });
      await setup.connect();
      await setup.query(`CREATE SCHEMA IF NOT EXISTS "${schema.replace(/"/g, "")}"`);
      await setup.end();
    }
    const pool = new pg.Pool({ connectionString: target, max, ...(schema ? { options: `-c search_path=${schema}` } : {}) });
    db = new PgDb(pool);
  } else {
    if (target !== ":memory:") mkdirSync(dirname(target), { recursive: true });
    const raw = new DatabaseSync(target);
    raw.exec("PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;");
    db = new SqliteDb(raw);
  }
  await migrate(db);
  return db;
}
