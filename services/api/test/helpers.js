import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { randomBytes } from "node:crypto";
import pg from "pg";
import { openDb } from "../src/db.js";
import { loadContent } from "../src/content.js";
import { createApp } from "../src/app.js";

const here = dirname(fileURLToPath(import.meta.url));
export const CONTENT_DIR = resolve(here, "../../../content");
export const content = loadContent(CONTENT_DIR);

/**
 * A fresh, empty database for one test.
 * Default: SQLite in memory. With TEST_DATABASE_URL=postgres://… every test gets its own
 * PostgreSQL schema, dropped again by db.close(): the same tests run on both databases.
 */
export const TEST_PG = process.env.TEST_DATABASE_URL;
export async function newDb() {
  if (!TEST_PG) return openDb(":memory:");
  const schema = `t_${randomBytes(6).toString("hex")}`;
  const db = await openDb(TEST_PG, { schema, max: 4 });
  const close = db.close.bind(db);
  db.close = async () => {
    await close();
    const c = new pg.Client({ connectionString: TEST_PG });
    await c.connect();
    await c.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await c.end();
  };
  return db;
}

/** Start the API on a random port with an empty database. */
export async function startTestServer({ now, staffAuth = false } = {}) {
  const db = await newDb();
  const app = createApp({ db, content, now, staffAuth, webhookSecret: "" });
  const server = await new Promise((ok) => {
    const s = app.listen(0, () => ok(s));
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = async (method, path, body, headers = {}) => {
    const res = await fetch(base + path, {
      method,
      headers: { ...(body ? { "Content-Type": "application/json" } : {}), ...headers },
      body: body ? JSON.stringify(body) : undefined
    });
    return { status: res.status, body: await res.json() };
  };
  return { db, base, call, close: async () => { await new Promise((ok) => server.close(ok)); await db.close(); } };
}

export const kollie = {
  phone: "0777 123 456",
  name: "Kollie M.",
  county: "Bong",
  district: "Salala",
  consent: true,
  crops: [{ crop: "rice", planting_month: 5 }, { crop: "cassava", planting_month: 4 }]
};
