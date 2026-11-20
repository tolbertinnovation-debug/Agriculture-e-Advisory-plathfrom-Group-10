// HTTP hardening: security headers, CORS and a simple per-IP rate limit.

/** Basic browser security headers for every response. */
export function securityHeaders({ https = false } = {}) {
  return (req, res, next) => {
    res.set("X-Content-Type-Options", "nosniff");
    res.set("Referrer-Policy", "same-origin");
    res.set("X-Frame-Options", "DENY");
    res.set("Permissions-Policy", "camera=(), microphone=(), geolocation=()");
    if (https) res.set("Strict-Transport-Security", "max-age=31536000");
    next();
  };
}

/**
 * CORS. In production the dashboard and app are served by this server (same origin),
 * so no CORS is needed: pass the allowed origins in CORS_ORIGINS if another site must call the API.
 * origins: "*" (development), [] (none), or a list.
 */
export function cors(origins) {
  return (req, res, next) => {
    const origin = req.get("origin");
    const allowed = origins === "*" ? "*" : origin && origins.includes(origin) ? origin : null;
    if (allowed) {
      res.set("Access-Control-Allow-Origin", allowed);
      res.set("Access-Control-Allow-Headers", "Content-Type, Authorization");
      res.set("Access-Control-Allow-Methods", "GET,POST,PATCH,OPTIONS");
      if (allowed !== "*") res.set("Vary", "Origin");
    }
    if (req.method === "OPTIONS") return res.sendStatus(allowed ? 204 : 403);
    next();
  };
}

/**
 * At most `max` requests per IP address in `windowMs`. In memory: fine for one server.
 * (Accounts are also locked after 5 wrong passwords; this stops one address guessing many accounts.)
 */
export function rateLimit({ max, windowMs, now = () => Date.now(), message = "Too many tries. Please wait a few minutes." }) {
  const hits = new Map();
  return (req, res, next) => {
    const t = now();
    const key = req.ip ?? "unknown";
    const list = (hits.get(key) ?? []).filter((x) => t - x < windowMs);
    if (list.length >= max) {
      res.set("Retry-After", String(Math.ceil((windowMs - (t - list[0])) / 1000)));
      return res.status(429).json({ error: message });
    }
    list.push(t);
    hits.set(key, list);
    if (hits.size > 10000) for (const [k, v] of hits) if (!v.some((x) => t - x < windowMs)) hits.delete(k);
    next();
  };
}
