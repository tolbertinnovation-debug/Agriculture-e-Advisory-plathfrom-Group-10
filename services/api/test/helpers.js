import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { openDb } from "../src/db.js";
import { loadContent } from "../src/content.js";
import { createApp } from "../src/app.js";

const here = dirname(fileURLToPath(import.meta.url));
export const CONTENT_DIR = resolve(here, "../../../content");
export const content = loadContent(CONTENT_DIR);

/** Start the API on a random port with an empty in-memory database. */
export async function startTestServer({ now, officerToken = "" } = {}) {
  const db = openDb(":memory:");
  const app = createApp({ db, content, now, officerToken, webhookSecret: "" });
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
  return { db, base, call, close: () => new Promise((ok) => server.close(ok)) };
}

export const kollie = {
  phone: "0777 123 456",
  name: "Kollie M.",
  county: "Bong",
  district: "Salala",
  consent: true,
  crops: [{ crop: "rice", planting_month: 5 }, { crop: "cassava", planting_month: 4 }]
};
