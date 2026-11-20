// Staff accounts for the officer dashboard: personal logins, roles, county limits,
// optional 2-step login (authenticator app codes, TOTP) and an audit log.
//
// Roles
//   admin    everything, including managing staff accounts and reading the audit log
//   officer  farmer reports, questions, hotspots and advisories, ONLY for their own counties
//   editor   market prices, reporters, weather refresh, advice job (content work)
//   viewer   read-only numbers (for partners): stats and hotspots, no personal data
import { scryptSync, randomBytes, timingSafeEqual, createHash, createHmac } from "node:crypto";
import { ValidationError } from "./farmers.js";
import { findCounty } from "./geo.js";

export const ROLES = ["admin", "officer", "editor", "viewer"];

export const PERMISSIONS = {
  admin: ["*"],
  officer: [
    "stats:read", "hotspots:read", "farmers:read", "farmers:write", "reports:read", "reports:write",
    "questions:read", "questions:write", "broadcasts:read", "broadcasts:send",
    "prices:read", "jobs:read", "weather:run"
  ],
  editor: ["stats:read", "hotspots:read", "prices:read", "prices:write", "reporters:write", "jobs:read", "jobs:run", "weather:run", "broadcasts:read"],
  viewer: ["stats:read", "hotspots:read"]
};

export const can = (staff, perm) => !!staff && (PERMISSIONS[staff.role]?.includes("*") || PERMISSIONS[staff.role]?.includes(perm));
export const permissionsFor = (role) => (PERMISSIONS[role]?.includes("*") ? Object.values(PERMISSIONS).flat().filter((p) => p !== "*").filter((p, i, a) => a.indexOf(p) === i).concat(["staff:manage", "audit:read", "messages:read"]) : PERMISSIONS[role] ?? []);

export const PASSWORD_MIN = 10;
export const MAX_FAILED_LOGINS = 5;
export const LOCK_MINUTES = 15;
export const SESSION_HOURS = 12;
const MIN = 60 * 1000;
const sha = (t) => createHash("sha256").update(t).digest("hex");

export class AccessError extends Error {
  constructor(message, status = 403, extra = {}) { super(message); this.status = status; this.auth = true; this.extra = extra; }
}

// ---------------------------------------------------------------- passwords (scrypt)
export function hashPassword(password) {
  const salt = randomBytes(16);
  const hash = scryptSync(password, salt, 64, { N: 16384, r: 8, p: 1 });
  return `scrypt$16384$8$1$${salt.toString("base64")}$${hash.toString("base64")}`;
}

export function verifyPassword(password, stored) {
  const [alg, N, r, p, salt, hash] = String(stored ?? "").split("$");
  if (alg !== "scrypt" || typeof password !== "string") return false;
  const expected = Buffer.from(hash, "base64");
  const got = scryptSync(password, Buffer.from(salt, "base64"), expected.length, { N: Number(N), r: Number(r), p: Number(p) });
  return timingSafeEqual(expected, got);
}

/** A random, readable password for new accounts and resets (shown once). */
export function generatePassword() {
  const words = randomBytes(12).toString("base64url").replace(/[-_]/g, "x");
  return `${words.slice(0, 4)}-${words.slice(4, 8)}-${words.slice(8, 12)}`;
}

// ---------------------------------------------------------------- TOTP (RFC 6238, as used by Google Authenticator etc.)
const B32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
export function base32Encode(buf) {
  let bits = 0, value = 0, out = "";
  for (const byte of buf) {
    value = (value << 8) | byte; bits += 8;
    while (bits >= 5) { out += B32[(value >>> (bits - 5)) & 31]; bits -= 5; }
  }
  if (bits > 0) out += B32[(value << (5 - bits)) & 31];
  return out;
}
export function base32Decode(text) {
  let bits = 0, value = 0;
  const out = [];
  for (const ch of String(text).toUpperCase().replace(/[^A-Z2-7]/g, "")) {
    value = (value << 5) | B32.indexOf(ch); bits += 5;
    if (bits >= 8) { out.push((value >>> (bits - 8)) & 255); bits -= 8; }
  }
  return Buffer.from(out);
}

/** The code for a given 30-second step. */
export function totpAt(secretBuf, step, digits = 6) {
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(step));
  const h = createHmac("sha1", secretBuf).update(counter).digest();
  const offset = h[h.length - 1] & 15;
  const bin = ((h[offset] & 127) << 24) | (h[offset + 1] << 16) | (h[offset + 2] << 8) | h[offset + 3];
  return String(bin % 10 ** digits).padStart(digits, "0");
}

/** Returns the matching time step (allowing ±1 step for phone clock drift), or null. */
export function checkTotp(secretBase32, code, now) {
  if (!/^\d{6}$/.test(String(code ?? ""))) return null;
  const secret = base32Decode(secretBase32);
  const step = Math.floor(now.getTime() / 1000 / 30);
  for (const s of [step - 1, step, step + 1]) {
    if (timingSafeEqual(Buffer.from(totpAt(secret, s)), Buffer.from(String(code)))) return s;
  }
  return null;
}

// ---------------------------------------------------------------- accounts
function cleanCounties(list, role) {
  const counties = [];
  for (const c of list ?? []) {
    const county = findCounty(c);
    if (!county) throw new ValidationError([`counties: unknown county "${c}"`]);
    if (!counties.includes(county)) counties.push(county);
  }
  if (role === "officer" && !counties.length) throw new ValidationError(["counties: an officer needs at least one county"]);
  return counties;
}

const publicStaff = (row) => row && ({
  id: row.id, email: row.email, name: row.name, role: row.role, counties: JSON.parse(row.counties),
  two_factor: !!row.totp_enabled, active: !!row.active, last_login_at: row.last_login_at, created_at: row.created_at
});

export function createStaff(db, { email, name, role, counties, password }) {
  const errors = [];
  const mail = typeof email === "string" ? email.trim().toLowerCase() : "";
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(mail)) errors.push("email: enter a valid email address");
  if (!ROLES.includes(role)) errors.push(`role: one of ${ROLES.join(", ")}`);
  if (typeof name !== "string" || !name.trim()) errors.push("name: required");
  if (errors.length) throw new ValidationError(errors);
  const list = cleanCounties(counties, role);
  const pw = password ?? generatePassword();
  if (pw.length < PASSWORD_MIN) throw new ValidationError([`password: at least ${PASSWORD_MIN} characters`]);
  if (db.prepare("SELECT 1 FROM staff WHERE email = ?").get(mail)) throw new ValidationError(["email: an account with this email already exists"]);
  const { lastInsertRowid } = db
    .prepare("INSERT INTO staff (email, name, role, counties, password_hash) VALUES (?, ?, ?, ?, ?)")
    .run(mail, name.trim().slice(0, 80), role, JSON.stringify(list), hashPassword(pw));
  return { staff: getStaff(db, Number(lastInsertRowid)), password: pw };
}

export function getStaff(db, id) {
  return publicStaff(db.prepare("SELECT * FROM staff WHERE id = ?").get(id));
}
export function listStaff(db) {
  return db.prepare("SELECT * FROM staff ORDER BY active DESC, role, name").all().map(publicStaff);
}

export function updateStaff(db, id, { name, role, counties, active }) {
  const row = db.prepare("SELECT * FROM staff WHERE id = ?").get(id);
  if (!row) return null;
  const nextRole = role ?? row.role;
  if (!ROLES.includes(nextRole)) throw new ValidationError([`role: one of ${ROLES.join(", ")}`]);
  const list = counties !== undefined || role !== undefined ? cleanCounties(counties ?? JSON.parse(row.counties), nextRole) : JSON.parse(row.counties);
  db.prepare("UPDATE staff SET name = ?, role = ?, counties = ?, active = ? WHERE id = ?")
    .run(typeof name === "string" && name.trim() ? name.trim().slice(0, 80) : row.name, nextRole, JSON.stringify(list), active === undefined ? row.active : active ? 1 : 0, id);
  if (active === false) db.prepare("DELETE FROM staff_sessions WHERE staff_id = ?").run(id); // log them out everywhere
  return getStaff(db, id);
}

export function setPassword(db, id, password) {
  if (typeof password !== "string" || password.length < PASSWORD_MIN) throw new ValidationError([`password: at least ${PASSWORD_MIN} characters`]);
  db.prepare("UPDATE staff SET password_hash = ?, failed_logins = 0, locked_until = NULL WHERE id = ?").run(hashPassword(password), id);
  db.prepare("DELETE FROM staff_sessions WHERE staff_id = ?").run(id);
}

// ---------------------------------------------------------------- login & sessions
/**
 * Check email + password (+ 6-digit code when 2-step login is on).
 * Returns { token, staff, needs_2fa_setup } or throws AccessError.
 */
export function login(db, { email, password, code }, now, { require2fa = false } = {}) {
  const mail = String(email ?? "").trim().toLowerCase();
  const row = db.prepare("SELECT * FROM staff WHERE email = ?").get(mail);
  const fail = (msg = "Wrong email or password") => {
    if (row) {
      const failed = row.failed_logins + 1;
      const lock = failed >= MAX_FAILED_LOGINS ? new Date(now.getTime() + LOCK_MINUTES * MIN).toISOString() : null;
      db.prepare("UPDATE staff SET failed_logins = ?, locked_until = COALESCE(?, locked_until) WHERE id = ?").run(lock ? 0 : failed, lock, row.id);
    }
    throw new AccessError(msg, 401);
  };
  if (row?.locked_until && row.locked_until > now.toISOString()) throw new AccessError(`Too many wrong tries. Try again after ${row.locked_until.slice(11, 16)} UTC.`, 429);
  // Always run scrypt, even for unknown emails, so timing does not reveal which emails exist.
  const ok = verifyPassword(String(password ?? ""), row?.password_hash ?? hashPassword("not-a-real-password"));
  if (!row || !ok || !row.active) fail();
  if (row.totp_enabled) {
    if (!code) throw new AccessError("Enter the 6-digit code from your authenticator app", 401, { needs_code: true });
    const step = checkTotp(row.totp_secret, code, now);
    if (step === null || step <= (row.totp_last_step ?? -1)) fail("Wrong or already used code");
    db.prepare("UPDATE staff SET totp_last_step = ? WHERE id = ?").run(step, row.id);
  }
  const mfaOk = row.totp_enabled ? 1 : require2fa ? 0 : 1;
  const token = randomBytes(32).toString("base64url");
  db.prepare("INSERT INTO staff_sessions (token_hash, staff_id, mfa_ok, expires_at, created_at) VALUES (?, ?, ?, ?, ?)")
    .run(sha(token), row.id, mfaOk, new Date(now.getTime() + SESSION_HOURS * 60 * MIN).toISOString(), now.toISOString());
  db.prepare("UPDATE staff SET failed_logins = 0, locked_until = NULL, last_login_at = ? WHERE id = ?").run(now.toISOString(), row.id);
  return { token, staff: getStaff(db, row.id), needs_2fa_setup: !mfaOk };
}

export function sessionStaff(db, token, now) {
  if (!token) return null;
  const s = db.prepare("SELECT * FROM staff_sessions WHERE token_hash = ? AND expires_at > ?").get(sha(token), now.toISOString());
  if (!s) return null;
  const row = db.prepare("SELECT * FROM staff WHERE id = ? AND active = 1").get(s.staff_id);
  return row ? { ...publicStaff(row), mfa_ok: !!s.mfa_ok } : null;
}

export function logout(db, token) {
  if (token) db.prepare("DELETE FROM staff_sessions WHERE token_hash = ?").run(sha(token));
}

// ---------------------------------------------------------------- 2-step login setup
export function start2fa(db, id) {
  const row = db.prepare("SELECT email FROM staff WHERE id = ?").get(id);
  const secret = base32Encode(randomBytes(20));
  db.prepare("UPDATE staff SET totp_secret = ?, totp_enabled = 0 WHERE id = ?").run(secret, id);
  const label = encodeURIComponent(`AgriConnect:${row.email}`);
  return { secret, otpauth_url: `otpauth://totp/${label}?secret=${secret}&issuer=AgriConnect&digits=6&period=30` };
}

export function enable2fa(db, id, code, now, token) {
  const row = db.prepare("SELECT totp_secret FROM staff WHERE id = ?").get(id);
  if (!row?.totp_secret) throw new ValidationError(["Start the setup first"]);
  const step = checkTotp(row.totp_secret, code, now);
  if (step === null) throw new ValidationError(["code: wrong code. Check the time on your phone and try again."]);
  db.prepare("UPDATE staff SET totp_enabled = 1, totp_last_step = ? WHERE id = ?").run(step, id);
  // This session has now proved the second step.
  if (token) db.prepare("UPDATE staff_sessions SET mfa_ok = 1 WHERE token_hash = ?").run(sha(token));
}

export function disable2fa(db, id) {
  db.prepare("UPDATE staff SET totp_enabled = 0, totp_secret = NULL, totp_last_step = NULL WHERE id = ?").run(id);
}

// ---------------------------------------------------------------- audit log
export function audit(db, staff, action, target = null, detail = null) {
  db.prepare("INSERT INTO audit_log (staff_id, staff_email, action, target, detail) VALUES (?, ?, ?, ?, ?)")
    .run(staff?.id ?? null, staff?.email ?? null, action, target, detail ? JSON.stringify(detail).slice(0, 2000) : null);
}

export function listAudit(db, { limit = 100 } = {}) {
  return db.prepare("SELECT * FROM audit_log ORDER BY id DESC LIMIT ?").all(limit)
    .map((r) => ({ ...r, detail: r.detail ? JSON.parse(r.detail) : null }));
}
