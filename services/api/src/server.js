// Starts the API: opens the database, loads and checks content, listens on PORT.
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { openDb } from "./db.js";
import { loadContent, validateContent } from "./content.js";
import { createApp } from "./app.js";

const here = dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT ?? 3000);
const DB_PATH = process.env.DB_PATH ?? resolve(here, "../data/agriconnect.db");
const CONTENT_DIR = process.env.CONTENT_DIR ?? resolve(here, "../../../content");

const content = loadContent(CONTENT_DIR);
const problems = validateContent(content);
if (problems.length) {
  console.error("Content has problems. Fix the files in /content:\n - " + problems.join("\n - "));
  process.exit(1);
}

const db = openDb(DB_PATH);
const app = createApp({ db, content });
app.listen(PORT, () => {
  console.log(`AgriConnect API running on http://localhost:${PORT}`);
  console.log(`Database: ${DB_PATH}`);
  console.log(`Content: ${content.crops.size} crops, ${content.pests.length} pests`);
  if (!process.env.OFFICER_TOKEN) console.warn("OFFICER_TOKEN is not set: officer pages are open. Fine on your laptop, never on a shared server.");
});
