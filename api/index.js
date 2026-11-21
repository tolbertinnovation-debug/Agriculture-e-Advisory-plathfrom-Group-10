// Vercel entry point: every request that is not a static file (see vercel.json) comes here and is
// handled by the AgriConnect app in services/api. See docs/vercel.md.
import { getServerlessApp } from "../services/api/src/serverless.js";

export default async function handler(req, res) {
  let app;
  try {
    app = await getServerlessApp();
  } catch (err) {
    console.error(err);
    res.statusCode = 503;
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    res.setHeader("Cache-Control", "no-store");
    // Setting problems are safe to show (they name settings, not secrets); anything else stays in the logs.
    res.end(JSON.stringify({ error: "AgriConnect is not ready", problems: err.fatal ?? ["The database could not be reached. See the function logs in Vercel."] }));
    return;
  }
  return app(req, res);
}
