// Farmer sign-in for the smartphone app: phone number + 6-digit code sent by SMS.
// No passwords to forget. Sessions last 90 days so farmers stay signed in while offline.
import { randomInt, randomBytes, createHash, timingSafeEqual } from "node:crypto";
import { sendSms } from "./messaging.js";
import { getFarmerByPhone } from "./farmers.js";

export const OTP_TTL_MIN = 10;
export const OTP_MAX_TRIES = 5;          // wrong guesses per code
export const OTP_MAX_REQUESTS = 3;       // codes per phone per 15 minutes
export const SESSION_DAYS = 90;
const MIN = 60 * 1000;

const sha = (text) => createHash("sha256").update(text).digest("hex");

export class AuthError extends Error {
  constructor(message, status = 400) { super(message); this.status = status; this.auth = true; }
}

/** Create a code and SMS it. Returns the code (the API only shows it in development). */
export async function requestOtp(db, phone, now) {
  const recent = (await db.get("SELECT COUNT(*) AS n FROM otp_codes WHERE phone = ? AND created_at >= ?",
    phone, new Date(now.getTime() - 15 * MIN).toISOString())).n;
  if (recent >= OTP_MAX_REQUESTS) throw new AuthError("Too many codes requested. Wait 15 minutes and try again.", 429);
  const code = String(randomInt(0, 1_000_000)).padStart(6, "0");
  await db.run("INSERT INTO otp_codes (phone, code_hash, expires_at, created_at) VALUES (?, ?, ?, ?)",
    phone, sha(`${phone}:${code}`), new Date(now.getTime() + OTP_TTL_MIN * MIN).toISOString(), now.toISOString());
  const farmer = await getFarmerByPhone(db, phone);
  await sendSms(db, { phone, farmerId: farmer?.id ?? null, body: `Your AgriConnect code is ${code}. It expires in ${OTP_TTL_MIN} minutes. Never share it.`, force: true, kind: "alert" });
  return code;
}

/** Check a code. Returns a new session token, or throws AuthError. */
export async function verifyOtp(db, phone, code, now) {
  const row = await db.get("SELECT * FROM otp_codes WHERE phone = ? AND used_at IS NULL AND expires_at > ? ORDER BY id DESC LIMIT 1",
    phone, now.toISOString());
  if (!row) throw new AuthError("Code expired. Ask for a new code.");
  if (row.attempts >= OTP_MAX_TRIES) throw new AuthError("Too many wrong codes. Ask for a new code.");
  const ok = typeof code === "string" && /^\d{6}$/.test(code) &&
    timingSafeEqual(Buffer.from(row.code_hash), Buffer.from(sha(`${phone}:${code}`)));
  if (!ok) {
    await db.run("UPDATE otp_codes SET attempts = attempts + 1 WHERE id = ?", row.id);
    throw new AuthError("Wrong code. Check the SMS and try again.");
  }
  // Mark the code used only if nobody else used it in the meantime (two taps on "Sign in").
  const used = await db.run("UPDATE otp_codes SET used_at = ? WHERE id = ? AND used_at IS NULL", now.toISOString(), row.id);
  if (!used.changes) throw new AuthError("Code expired. Ask for a new code.");
  const token = randomBytes(32).toString("base64url");
  await db.run("INSERT INTO farmer_sessions (token_hash, phone, expires_at, created_at) VALUES (?, ?, ?, ?)",
    sha(token), phone, new Date(now.getTime() + SESSION_DAYS * 24 * 60 * MIN).toISOString(), now.toISOString());
  return token;
}

export async function sessionPhone(db, token, now) {
  if (!token) return null;
  const row = await db.get("SELECT phone FROM farmer_sessions WHERE token_hash = ? AND expires_at > ?", sha(token), now.toISOString());
  return row?.phone ?? null;
}

export async function endSession(db, token) {
  if (token) await db.run("DELETE FROM farmer_sessions WHERE token_hash = ?", sha(token));
}

/** Express middleware: requires "Authorization: Bearer <session token>"; sets req.phone and req.farmer (null if not registered yet). */
export function farmerAuth(ctx) {
  return async (req, res, next) => {
    try {
      const token = (req.get("authorization") ?? "").replace(/^Bearer\s+/i, "");
      const phone = await sessionPhone(ctx.db, token, ctx.now());
      if (!phone) return res.status(401).json({ error: "Please sign in again" });
      req.token = token;
      req.phone = phone;
      req.farmer = await getFarmerByPhone(ctx.db, phone);
      next();
    } catch (err) {
      next(err);
    }
  };
}
