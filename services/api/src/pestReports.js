// Pest reports: create a report, suggest the likely pest, and build the SMS reply.
import { ValidationError, getFarmerByPhone, getFarmer } from "./farmers.js";
import { diagnose } from "./engine.js";
import { findCounty, normalizePhone } from "./geo.js";
import { sendSms } from "./messaging.js";

const FALLBACK_SMS =
  "Thank you. We could not match these signs. An extension officer will call you. Ref: {ref}. Dial *347# for help";

export const STATUSES = ["new", "verified", "rejected", "closed"];

export function createPestReport(db, content, input) {
  const errors = [];
  const symptoms = Array.isArray(input.symptoms) ? [...new Set(input.symptoms)] : [];
  if (!symptoms.length) errors.push("symptoms: choose at least one symptom");
  for (const s of symptoms) if (!content.symptoms[s]) errors.push(`symptoms: unknown code "${s}"`);

  // Find the farmer by id or phone. Unregistered farmers can still report (e.g. first contact over USSD).
  let farmer = null;
  if (input.farmer_id != null) {
    farmer = getFarmer(db, Number(input.farmer_id));
    if (!farmer) errors.push("farmer_id: no such farmer");
  } else if (input.phone != null) {
    if (!normalizePhone(input.phone)) errors.push("phone: not a valid Liberian mobile number");
    else farmer = getFarmerByPhone(db, input.phone);
  } else errors.push("phone or farmer_id is required");

  const county = farmer?.county ?? findCounty(input.county);
  if (!county && !errors.length) errors.push("county: required for farmers who are not registered");
  if (errors.length) throw new ValidationError(errors);

  const crop = typeof input.crop === "string" ? input.crop : null;
  const match = diagnose(symptoms, content, crop);
  const { lastInsertRowid } = db
    .prepare(`INSERT INTO pest_reports (farmer_id, phone, crop, symptoms, suggested_pest, match_score, county, district, channel)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(
      farmer?.id ?? null,
      farmer?.phone ?? normalizePhone(input.phone),
      crop,
      JSON.stringify(symptoms),
      match?.pest.id ?? null,
      match?.score ?? null,
      county,
      farmer?.district ?? input.district ?? null,
      input.channel ?? "app"
    );

  const report = getPestReport(db, Number(lastInsertRowid));
  const ref = `PR-${report.id}`;
  const lang = farmer?.language ?? "en";
  const reply_sms = match ? `${match.pest.sms[lang] ?? match.pest.sms.en}`.replace("Officer told.", `Ref ${ref}`) : FALLBACK_SMS.replace("{ref}", ref);
  return {
    report,
    ref,
    diagnosis: match ? { pest: match.pest.id, name: match.pest.name, score: match.score } : null,
    reply_sms
  };
}

function parse(row) {
  return row ? { ...row, symptoms: JSON.parse(row.symptoms) } : null;
}

export function getPestReport(db, id) {
  return parse(db.prepare("SELECT * FROM pest_reports WHERE id = ?").get(id));
}

export function listPestReports(db, { county, status, limit = 100 } = {}) {
  const where = [];
  const args = [];
  if (county) { where.push("county = ?"); args.push(county); }
  if (status) { where.push("status = ?"); args.push(status); }
  const sql = `SELECT * FROM pest_reports ${where.length ? "WHERE " + where.join(" AND ") : ""} ORDER BY id DESC LIMIT ?`;
  return db.prepare(sql).all(...args, limit).map(parse);
}

/**
 * Officer action on a report: verify (optionally correcting the pest), reject or close.
 * When a report is verified, the farmer gets a short SMS so they know a person checked it.
 */
export function updatePestReport(db, content, id, input) {
  const report = getPestReport(db, id);
  if (!report) return null;
  const errors = [];
  const status = input.status ?? report.status;
  if (!STATUSES.includes(status)) errors.push(`status: must be one of ${STATUSES.join(", ")}`);
  let confirmed = report.confirmed_pest;
  if (input.confirmed_pest !== undefined) {
    if (input.confirmed_pest === null || input.confirmed_pest === "") confirmed = null;
    else if (!content.pests.some((p) => p.id === input.confirmed_pest)) errors.push(`confirmed_pest: unknown pest "${input.confirmed_pest}"`);
    else confirmed = input.confirmed_pest;
  }
  if (errors.length) throw new ValidationError(errors);

  db.prepare("UPDATE pest_reports SET status = ?, confirmed_pest = ? WHERE id = ?").run(status, confirmed, id);
  const updated = getPestReport(db, id);

  let notified = false;
  if (status === "verified" && report.status !== "verified" && updated.phone) {
    const pestId = confirmed ?? updated.suggested_pest;
    const name = content.pests.find((p) => p.id === pestId)?.name;
    const body = name
      ? `AgriConnect: an extension officer confirmed ${name.toUpperCase()} (Ref PR-${id}). Follow the steps we sent. Dial *347# option 5 for a call-back.`
      : `AgriConnect: an extension officer checked your report (Ref PR-${id}) and will call you. Dial *347# for help.`;
    sendSms(db, { phone: updated.phone, farmerId: updated.farmer_id, body, force: true });
    notified = true;
  }
  return { report: updated, notified };
}
