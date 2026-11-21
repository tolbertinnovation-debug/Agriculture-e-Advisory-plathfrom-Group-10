// HTTP hardening: security headers, CORS and a simple per-IP rate limit.

/** Basic browser security headers for every response. */
export function securityHeaders({ https = false } = {}) {
  return (req, res, next) => {
    res.set("X-Content-Type-Options", "nosniff");
    res.set("Referrer-Policy", "same-origin");
    res.set("X-Frame-Options", "DENY");
    // The farmer app may use the camera (photo questions are picked with the phone's camera).
    res.set("Permissions-Policy", "camera=(self), microphone=(), geolocation=()");
    // Pages only load code, styles and pictures from this server, and only talk to this server.
    // (Inline scripts are allowed because the pages keep their script in the HTML file.)
    res.set("Content-Security-Policy", [
      "default-src 'self'", "script-src 'self' 'unsafe-inline'", "style-src 'self' 'unsafe-inline'",
      "img-src 'self' data: blob:", "connect-src 'self'", "object-src 'none'", "base-uri 'self'",
      "form-action 'self'", "frame-ancestors 'none'"
    ].join("; "));
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
export function rateLimit({ max, windowMs, now = () => Date.now(), message = "Too many tries. Please wait a few minutes.", key: keyOf = (req) => req.ip ?? "unknown" }) {
  const hits = new Map();
  return (req, res, next) => {
    const t = now();
    const key = keyOf(req);
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
