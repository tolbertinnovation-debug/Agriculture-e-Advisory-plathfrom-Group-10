// Staff accounts for the officer dashboard: personal logins, roles, county limits,
// optional 2-step login (authenticator app codes, TOTP) and an audit log.
//
// Roles
//   admin    everything, including managing staff accounts and reading the audit log
//   officer  farmer reports, questions, hotspots and advisories, ONLY for their own counties
//   editor   market prices, reporters, weather refresh, advice job (content work)
//   viewer   read-only numbers (for partners): stats and hotspots, no personal data
//   lead     lead farmer / co-op agent: registers farmers in their counties (each farmer
//            confirms by replying YES) and sees only the registrations they made
import { scryptSync, randomBytes, timingSafeEqual, createHash, createHmac } from "node:crypto";
import { ValidationError } from "./farmers.js";
import { findCounty, normalizePhone } from "./geo.js";

export const ROLES = ["admin", "officer", "editor", "viewer", "lead"];
/** Roles that only work in their own counties. */
export const AREA_ROLES = ["officer", "lead"];
export const isAreaLimited = (staff) => AREA_ROLES.includes(staff?.role);

export const PERMISSIONS = {
  admin: ["*"],
  officer: [
    "stats:read", "hotspots:read", "farmers:read", "farmers:edit", "farmers:export", "registrations:create", "registrations:read", "reports:read", "reports:write",
    "questions:read", "questions:write", "broadcasts:read", "broadcasts:send",
    "prices:read", "jobs:read", "weather:run"
  ],
  editor: ["stats:read", "hotspots:read", "prices:read", "prices:write", "reporters:write", "jobs:read", "jobs:run", "weather:run", "broadcasts:read"],
  viewer: ["stats:read", "hotspots:read"],
  lead: ["registrations:create", "registrations:read"]
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
/** Optional mobile number for alerts by SMS. "" or null clears it. */
function cleanStaffPhone(phone) {
  if (phone === undefined || phone === null || String(phone).trim() === "") return null;
  const p = normalizePhone(phone);
  if (!p) throw new ValidationError(["phone: not a valid Liberian mobile number"]);
  return p;
}

/** Districts an officer covers first (questions from there are routed to them). Free text, e.g. "Salala". */
function cleanDistricts(list) {
  if (list === undefined || list === null) return [];
  const arr = Array.isArray(list) ? list : String(list).split(",");
  return [...new Set(arr.map((d) => String(d).trim().slice(0, 60)).filter(Boolean))].slice(0, 30);
}

function cleanCounties(list, role) {
  const counties = [];
  for (const c of list ?? []) {
    const county = findCounty(c);
    if (!county) throw new ValidationError([`counties: unknown county "${c}"`]);
    if (!counties.includes(county)) counties.push(county);
  }
  if (AREA_ROLES.includes(role) && !counties.length) throw new ValidationError([`counties: ${role === "lead" ? "a lead farmer" : "an officer"} needs at least one county`]);
  return counties;
}

const publicStaff = (row) => row && ({
  id: row.id, email: row.email, name: row.name, role: row.role, counties: JSON.parse(row.counties), districts: JSON.parse(row.districts ?? "[]"), phone: row.phone ?? null,
  two_factor: !!row.totp_enabled, active: !!row.active, last_login_at: row.last_login_at, created_at: row.created_at
});

export async function createStaff(db, { email, name, role, counties, password, phone, districts }) {
  const errors = [];
  const mail = typeof email === "string" ? email.trim().toLowerCase() : "";
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(mail)) errors.push("email: enter a valid email address");
  if (!ROLES.includes(role)) errors.push(`role: one of ${ROLES.join(", ")}`);
  if (typeof name !== "string" || !name.trim()) errors.push("name: required");
  if (errors.length) throw new ValidationError(errors);
  const list = cleanCounties(counties, role);
  const mobile = cleanStaffPhone(phone);
  const pw = password ?? generatePassword();
  if (pw.length < PASSWORD_MIN) throw new ValidationError([`password: at least ${PASSWORD_MIN} characters`]);
  if (await db.get("SELECT 1 AS x FROM staff WHERE email = ?", mail)) throw new ValidationError(["email: an account with this email already exists"]);
  const { id } = await db.get("INSERT INTO staff (email, name, role, counties, password_hash, phone, districts) VALUES (?, ?, ?, ?, ?, ?, ?) RETURNING id",
    mail, name.trim().slice(0, 80), role, JSON.stringify(list), hashPassword(pw), mobile, JSON.stringify(cleanDistricts(districts)));
  return { staff: await getStaff(db, id), password: pw };
}

export async function getStaff(db, id) {
  return publicStaff(await db.get("SELECT * FROM staff WHERE id = ?", id));
}
export async function listStaff(db) {
  return (await db.all("SELECT * FROM staff ORDER BY active DESC, role, name, id")).map(publicStaff);
}

export async function updateStaff(db, id, { name, role, counties, active, phone, districts }) {
  const row = await db.get("SELECT * FROM staff WHERE id = ?", id);
  if (!row) return null;
  const nextRole = role ?? row.role;
  if (!ROLES.includes(nextRole)) throw new ValidationError([`role: one of ${ROLES.join(", ")}`]);
  const list = counties !== undefined || role !== undefined ? cleanCounties(counties ?? JSON.parse(row.counties), nextRole) : JSON.parse(row.counties);
  const mobile = phone === undefined ? row.phone : cleanStaffPhone(phone);
  const dist = districts === undefined ? row.districts : JSON.stringify(cleanDistricts(districts));
  await db.run("UPDATE staff SET name = ?, role = ?, counties = ?, active = ?, phone = ?, districts = ? WHERE id = ?",
    typeof name === "string" && name.trim() ? name.trim().slice(0, 80) : row.name, nextRole, JSON.stringify(list), active === undefined ? row.active : active ? 1 : 0, mobile, dist, id);
  if (active === false) await db.run("DELETE FROM staff_sessions WHERE staff_id = ?", id); // log them out everywhere
  return getStaff(db, id);
}

export async function setPassword(db, id, password) {
  if (typeof password !== "string" || password.length < PASSWORD_MIN) throw new ValidationError([`password: at least ${PASSWORD_MIN} characters`]);
  await db.run("UPDATE staff SET password_hash = ?, failed_logins = 0, locked_until = NULL WHERE id = ?", hashPassword(password), id);
  await db.run("DELETE FROM staff_sessions WHERE staff_id = ?", id);
}

// ---------------------------------------------------------------- login & sessions
/**
 * Check email + password (+ 6-digit code when 2-step login is on).
 * Returns { token, staff, needs_2fa_setup } or throws AccessError.
 */
export async function login(db, { email, password, code }, now, { require2fa = false } = {}) {
  const mail = String(email ?? "").trim().toLowerCase();
  const row = await db.get("SELECT * FROM staff WHERE email = ?", mail);
  const fail = async (msg = "Wrong email or password") => {
    if (row) {
      const failed = row.failed_logins + 1;
      const lock = failed >= MAX_FAILED_LOGINS ? new Date(now.getTime() + LOCK_MINUTES * MIN).toISOString() : null;
      await db.run("UPDATE staff SET failed_logins = ?, locked_until = COALESCE(?, locked_until) WHERE id = ?", lock ? 0 : failed, lock, row.id);
    }
    throw new AccessError(msg, 401);
  };
  if (row?.locked_until && row.locked_until > now.toISOString()) throw new AccessError(`Too many wrong tries. Try again after ${row.locked_until.slice(11, 16)} UTC.`, 429);
  // Always run scrypt, even for unknown emails, so timing does not reveal which emails exist.
  const ok = verifyPassword(String(password ?? ""), row?.password_hash ?? hashPassword("not-a-real-password"));
  if (!row || !ok || !row.active) await fail();
  if (row.totp_enabled) {
    if (!code) throw new AccessError("Enter the 6-digit code from your authenticator app", 401, { needs_code: true });
    const step = checkTotp(row.totp_secret, code, now);
    if (step === null) await fail("Wrong or already used code");
    // Accept each code once: only move forward if no login used this (or a later) code already.
    const fresh = await db.run("UPDATE staff SET totp_last_step = ? WHERE id = ? AND (totp_last_step IS NULL OR totp_last_step < ?)", step, row.id, step);
    if (!fresh.changes) await fail("Wrong or already used code");
  }
  const mfaOk = row.totp_enabled ? 1 : require2fa ? 0 : 1;
  const token = randomBytes(32).toString("base64url");
  await db.run("INSERT INTO staff_sessions (token_hash, staff_id, mfa_ok, expires_at, created_at) VALUES (?, ?, ?, ?, ?)",
    sha(token), row.id, mfaOk, new Date(now.getTime() + SESSION_HOURS * 60 * MIN).toISOString(), now.toISOString());
  await db.run("UPDATE staff SET failed_logins = 0, locked_until = NULL, last_login_at = ? WHERE id = ?", now.toISOString(), row.id);
  return { token, staff: await getStaff(db, row.id), needs_2fa_setup: !mfaOk };
}

export async function sessionStaff(db, token, now) {
  if (!token) return null;
  const s = await db.get("SELECT * FROM staff_sessions WHERE token_hash = ? AND expires_at > ?", sha(token), now.toISOString());
  if (!s) return null;
  const row = await db.get("SELECT * FROM staff WHERE id = ? AND active = 1", s.staff_id);
  return row ? { ...publicStaff(row), mfa_ok: !!s.mfa_ok } : null;
}

export async function logout(db, token) {
  if (token) await db.run("DELETE FROM staff_sessions WHERE token_hash = ?", sha(token));
}

// ---------------------------------------------------------------- 2-step login setup
export async function start2fa(db, id) {
  const row = await db.get("SELECT email FROM staff WHERE id = ?", id);
  const secret = base32Encode(randomBytes(20));
  await db.run("UPDATE staff SET totp_secret = ?, totp_enabled = 0 WHERE id = ?", secret, id);
  const label = encodeURIComponent(`AgriConnect:${row.email}`);
  return { secret, otpauth_url: `otpauth://totp/${label}?secret=${secret}&issuer=AgriConnect&digits=6&period=30` };
}

export async function enable2fa(db, id, code, now, token) {
  const row = await db.get("SELECT totp_secret FROM staff WHERE id = ?", id);
  if (!row?.totp_secret) throw new ValidationError(["Start the setup first"]);
  const step = checkTotp(row.totp_secret, code, now);
  if (step === null) throw new ValidationError(["code: wrong code. Check the time on your phone and try again."]);
  await db.run("UPDATE staff SET totp_enabled = 1, totp_last_step = ? WHERE id = ?", step, id);
  // This session has now proved the second step.
  if (token) await db.run("UPDATE staff_sessions SET mfa_ok = 1 WHERE token_hash = ?", sha(token));
}

export async function disable2fa(db, id) {
  await db.run("UPDATE staff SET totp_enabled = 0, totp_secret = NULL, totp_last_step = NULL WHERE id = ?", id);
}

// ---------------------------------------------------------------- audit log
export async function audit(db, staff, action, target = null, detail = null) {
  await db.run("INSERT INTO audit_log (staff_id, staff_email, action, target, detail) VALUES (?, ?, ?, ?, ?)",
    staff?.id ?? null, staff?.email ?? null, action, target, detail ? JSON.stringify(detail).slice(0, 2000) : null);
}

export async function listAudit(db, { limit = 100 } = {}) {
  return (await db.all("SELECT * FROM audit_log ORDER BY id DESC LIMIT ?", limit))
    .map((r) => ({ ...r, detail: r.detail ? JSON.parse(r.detail) : null }));
}
