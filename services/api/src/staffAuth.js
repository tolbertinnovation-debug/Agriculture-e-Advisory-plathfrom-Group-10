// Staff login for the officer dashboard: middleware, county limits and the /api/staff routes.
import { findCounty } from "./geo.js";
import {
  isAreaLimited, can, permissionsFor, AccessError, login, logout, sessionStaff, getStaff, listStaff, createStaff, updateStaff,
  setPassword, generatePassword, verifyPassword, start2fa, enable2fa, disable2fa, audit, listAudit
} from "./staff.js";

// When STAFF_AUTH=off (tests, quick local demos) every request acts as this admin.
const NO_AUTH_ADMIN = { id: null, email: null, name: "Local (login off)", role: "admin", counties: [], two_factor: false, mfa_ok: true };

const bearer = (req) => (req.get("authorization") ?? "").replace(/^Bearer\s+/i, "");

/**
 * Build the guards used by the routes:
 *   staff        any signed-in staff member (who has finished 2-step setup if it is required)
 *   need(perm)   signed in AND allowed by their role
 */
export function staffGuards({ db, now, enabled = true }) {
  const authenticate = (allowSetup) => async (req, res, next) => {
    try {
      if (!enabled) { req.staff = NO_AUTH_ADMIN; return next(); }
      const token = bearer(req);
      const staff = await sessionStaff(db, token, now());
      if (!staff) return res.status(401).json({ error: "Please log in", login: true });
      if (!staff.mfa_ok && !allowSetup) return res.status(403).json({ error: "Set up 2-step login first", setup_2fa: true });
      req.staff = staff;
      req.staffToken = token;
      next();
    } catch (err) {
      next(err);
    }
  };
  const staff = authenticate(false);
  const staffDuringSetup = authenticate(true);
  const need = (perm) => [staff, (req, res, next) => (can(req.staff, perm) ? next() : res.status(403).json({ error: "Your role cannot do this" }))];
  return { staff, staffDuringSetup, need };
}

/**
 * Which counties a request may cover. Officers are limited to their own counties;
 * everyone else may see all. Returns an array, or undefined for "all counties".
 */
export function scopeCounties(req, requested) {
  const s = req.staff;
  const county = requested ? findCounty(requested) : null;
  if (requested && !county) throw new AccessError("Unknown county", 400);
  if (!isAreaLimited(s)) return county ? [county] : undefined;
  if (county) {
    if (!s.counties.includes(county)) throw new AccessError(`You work in ${s.counties.join(", ")}, not ${county}`);
    return [county];
  }
  return s.counties;
}

/** Throws unless the staff member may act on something in this county. */
export function mustCover(req, county) {
  const s = req.staff;
  if (isAreaLimited(s) && !s.counties.includes(county)) throw new AccessError(`This belongs to ${county ?? "no county"}, outside your area (${s.counties.join(", ")})`);
}

export function staffRoutes(app, ctx, guards, { require2fa = false } = {}) {
  const { db, now } = ctx;
  const { staffDuringSetup, need } = guards;
  const me = (s) => ({ ...s, permissions: permissionsFor(s.role) });

  app.post("/api/staff/login", async (req, res, next) => {
    try {
      const r = await login(db, req.body ?? {}, now(), { require2fa });
      await audit(db, r.staff, "login");
      res.json({ token: r.token, staff: me(r.staff), needs_2fa_setup: r.needs_2fa_setup });
    } catch (err) {
      if (!err.auth) return next(err);
      if (err.status === 401 && !err.extra?.needs_code) await audit(db, null, "login.failed", String(req.body?.email ?? "").slice(0, 120));
      res.status(err.status).json({ error: err.message, ...(err.extra ?? {}) });
    }
  });

  app.post("/api/staff/logout", staffDuringSetup, async (req, res) => {
    await logout(db, req.staffToken);
    res.json({ ok: true });
  });

  app.get("/api/staff/me", staffDuringSetup, (req, res) => res.json(me(req.staff)));

  app.post("/api/staff/me/password", staffDuringSetup, async (req, res) => {
    const row = await db.get("SELECT password_hash FROM staff WHERE id = ?", req.staff.id);
    if (!row || !verifyPassword(String(req.body?.current ?? ""), row.password_hash)) throw new AccessError("Your current password is wrong", 400);
    await setPassword(db, req.staff.id, req.body?.new);
    await audit(db, req.staff, "password.change");
    res.json({ ok: true, note: "Password changed. Please log in again." });
  });

  // 2-step login: start (get a secret for the authenticator app), then confirm with a code.
  // Staff set their own mobile number for hotspot alerts by SMS ("" removes it).
  app.post("/api/staff/me/phone", staffDuringSetup, async (req, res) => {
    const updated = await updateStaff(db, req.staff.id, { phone: req.body?.phone ?? "" });
    await audit(db, req.staff, "staff.phone", updated.email, { phone: updated.phone });
    res.json(updated);
  });
  app.post("/api/staff/me/2fa/start", staffDuringSetup, async (req, res) => res.json(await start2fa(db, req.staff.id)));
  app.post("/api/staff/me/2fa/enable", staffDuringSetup, async (req, res) => {
    await enable2fa(db, req.staff.id, String(req.body?.code ?? ""), now(), req.staffToken);
    await audit(db, req.staff, "2fa.enable");
    res.json({ ok: true });
  });
  app.post("/api/staff/me/2fa/disable", staffDuringSetup, async (req, res) => {
    if (require2fa) throw new AccessError("2-step login is required on this server", 400);
    const row = await db.get("SELECT password_hash FROM staff WHERE id = ?", req.staff.id);
    if (!verifyPassword(String(req.body?.password ?? ""), row.password_hash)) throw new AccessError("Wrong password", 400);
    await disable2fa(db, req.staff.id);
    await audit(db, req.staff, "2fa.disable");
    res.json({ ok: true });
  });

  // ---- Admin: manage staff ----
  app.get("/api/staff", ...need("staff:manage"), async (req, res) => res.json(await listStaff(db)));

  app.post("/api/staff", ...need("staff:manage"), async (req, res) => {
    const { staff, password } = await createStaff(db, { ...req.body, password: undefined });
    await audit(db, req.staff, "staff.create", staff.email, { role: staff.role, counties: staff.counties });
    // The password is shown ONCE: give it to the person, who should change it.
    res.status(201).json({ staff, password });
  });

  app.patch("/api/staff/:id", ...need("staff:manage"), async (req, res) => {
    const id = Number(req.params.id);
    if (id === req.staff.id && (req.body?.active === false || (req.body?.role && req.body.role !== "admin")))
      throw new AccessError("You cannot remove your own admin access", 400);
    const updated = await updateStaff(db, id, req.body ?? {});
    if (!updated) return res.status(404).json({ error: "Staff member not found" });
    await audit(db, req.staff, "staff.update", updated.email, req.body);
    res.json(updated);
  });

  app.post("/api/staff/:id/reset-password", ...need("staff:manage"), async (req, res) => {
    const target = await getStaff(db, Number(req.params.id));
    if (!target) return res.status(404).json({ error: "Staff member not found" });
    const password = generatePassword();
    await setPassword(db, target.id, password);
    if (req.body?.reset_2fa) await disable2fa(db, target.id);
    await audit(db, req.staff, "staff.reset_password", target.email, { reset_2fa: !!req.body?.reset_2fa });
    res.json({ password });
  });

  app.get("/api/audit", ...need("audit:read"), async (req, res) => res.json(await listAudit(db, { limit: Math.min(Number(req.query.limit) || 100, 500) })));
}
