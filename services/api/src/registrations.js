// Assisted sign-up: an officer or lead farmer registers a farmer (e.g. at a co-op meeting),
// and the FARMER confirms with their own phone. Nothing is sent to them until they say YES.
//
//   createRegistration()   saves the details and SMSes an invitation:
//                          "… registered you … Reply YES to join or NO to refuse."
//   answerRegistration()   YES → the farmer is registered (consent = their own reply)
//                          NO  → nothing is kept except the refusal
// The farmer can also answer on *347# (the first screen asks them). Invitations expire
// after INVITE_DAYS; a registrar can resend at most MAX_INVITES times in total.
import { ValidationError, cleanFarmerInput, createFarmer, getFarmerByPhone } from "./farmers.js";
import { sendSms } from "./messaging.js";
import { sendAdviceToFarmer } from "./scheduler.js";
import { isUniqueViolation } from "./db.js";

export const INVITE_DAYS = 7;
export const MAX_INVITES = 3;
const DAY = 86400000;

const inviteText = (r, content) => {
  const crops = r.details.crops.map((c) => content.crops.get(c.crop)?.name.split(" ")[0] ?? c.crop).join(" & ");
  const who = (r.registrar_name ?? "An officer").slice(0, 22);
  return `AgriConnect: ${who} registered you for free ${crops} advice in ${r.county}. Reply YES to join or NO to refuse. Dial *347# for help.`.slice(0, 160);
};

const parse = (row) => (row ? { ...row, details: JSON.parse(row.details) } : null);

export async function getRegistration(db, id) {
  return parse(await db.get("SELECT * FROM registrations WHERE id = ?", id));
}

/** The invitation waiting for this phone, if any (expired ones are marked as such). */
export async function waitingRegistration(db, phone, now) {
  await db.run("UPDATE registrations SET status = 'expired' WHERE phone = ? AND status = 'waiting' AND expires_at <= ?", phone, now.toISOString());
  return parse(await db.get("SELECT * FROM registrations WHERE phone = ? AND status = 'waiting' ORDER BY id DESC LIMIT 1", phone));
}

/**
 * Save an assisted registration and invite the farmer. `staff` is the officer / lead farmer.
 * Throws ValidationError for bad input, or if the phone is already a registered farmer.
 */
export async function createRegistration(ctx, input, staff) {
  const { db, content } = ctx;
  const now = ctx.now();
  // Same checks as a normal registration, except consent: the farmer gives that by replying YES.
  const clean = cleanFarmerInput({ ...input, consent: true, channel: "assisted" }, content);
  if (await getFarmerByPhone(db, clean.phone)) throw new ValidationError(["phone: this farmer is already registered"]);
  const details = { name: clean.name, county: clean.county, district: clean.district, language: clean.language, crops: clean.crops };

  // A new registration for the same phone replaces any invitation still waiting.
  await db.run("UPDATE registrations SET status = 'cancelled' WHERE phone = ? AND status = 'waiting'", clean.phone);
  const { id } = await db.get(
    `INSERT INTO registrations (phone, details, county, registered_by, registrar_name, created_at, expires_at)
     VALUES (?, ?, ?, ?, ?, ?, ?) RETURNING id`,
    clean.phone, JSON.stringify(details), clean.county, staff?.id ?? null, staff?.name ?? null,
    now.toISOString(), new Date(now.getTime() + INVITE_DAYS * DAY).toISOString()
  );
  const reg = await getRegistration(db, id);
  await sendSms(db, { phone: reg.phone, body: inviteText(reg, content), force: true, kind: "alert" });
  return reg;
}

/** Send the invitation again (e.g. the farmer's phone was off). */
export async function resendRegistration(ctx, id) {
  const { db, content } = ctx;
  const reg = await getRegistration(db, id);
  if (!reg) return null;
  if (reg.status !== "waiting" || reg.expires_at <= ctx.now().toISOString()) throw new ValidationError(["This invitation is no longer waiting for an answer"]);
  if (reg.sms_sent >= MAX_INVITES) throw new ValidationError([`The invitation was already sent ${MAX_INVITES} times. Ask the farmer to dial *347#.`]);
  await db.run("UPDATE registrations SET sms_sent = sms_sent + 1 WHERE id = ?", id);
  await sendSms(db, { phone: reg.phone, body: inviteText(reg, content), force: true, kind: "alert" });
  return getRegistration(db, id);
}

export async function cancelRegistration(db, id) {
  const r = await db.run("UPDATE registrations SET status = 'cancelled' WHERE id = ? AND status = 'waiting'", id);
  return r.changes > 0;
}

/**
 * The farmer answers (by SMS or *347#). yes = true → registered, with welcome SMS and first advice.
 * Returns { status: "joined" | "refused" | "none", farmer? }.
 */
export async function answerRegistration(ctx, phone, yes) {
  const { db } = ctx;
  const now = ctx.now();
  const reg = await waitingRegistration(db, phone, now);
  if (!reg) return { status: "none" };
  if (!yes) {
    await db.run("UPDATE registrations SET status = 'refused', answered_at = ? WHERE id = ?", now.toISOString(), reg.id);
    await sendSms(db, { phone, body: "OK. You are not registered and will not get AgriConnect messages. Dial *347# if you change your mind.", force: true });
    return { status: "refused" };
  }
  let farmer;
  try {
    farmer = await createFarmer(db, {
      phone, name: reg.details.name, county: reg.details.county, district: reg.details.district,
      language: reg.details.language, channel: "assisted", registered_by: reg.registrar_name, crops: reg.details.crops
    });
  } catch (err) {
    if (!isUniqueViolation(err)) throw err;
    farmer = await getFarmerByPhone(db, phone); // registered another way in the meantime
  }
  await db.run("UPDATE registrations SET status = 'joined', answered_at = ?, farmer_id = ? WHERE id = ?", now.toISOString(), farmer.id, reg.id);
  await sendSms(db, {
    phone, farmerId: farmer.id, kind: "welcome",
    body: `Welcome to AgriConnect! You are registered in ${farmer.county} County. Farm advice is free. Reply STOP to stop. Dial *347# for help.`
  });
  await sendAdviceToFarmer(ctx, farmer);
  return { status: "joined", farmer };
}

/**
 * Registrations a staff member may see: admins all, officers their counties,
 * lead farmers only the ones they made themselves.
 */
export async function listRegistrations(db, staff, { status, limit = 100 } = {}) {
  const where = [];
  const args = [];
  if (staff.role === "lead") { where.push("registered_by = ?"); args.push(staff.id); }
  else if (staff.role === "officer") { where.push(`county IN (${staff.counties.map(() => "?").join(",") || "NULL"})`); args.push(...staff.counties); }
  if (status) { where.push("status = ?"); args.push(status); }
  return (await db.all(`SELECT * FROM registrations ${where.length ? "WHERE " + where.join(" AND ") : ""} ORDER BY id DESC LIMIT ?`, ...args, limit)).map(parse);
}

/** Who may act on one registration. */
export function mayManage(staff, reg) {
  if (staff.role === "lead") return reg.registered_by === staff.id;
  if (staff.role === "officer") return staff.counties.includes(reg.county);
  return true;
}
