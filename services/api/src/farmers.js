// Farmer data access: shared by the REST API now and the USSD/SMS handlers in step 2.
import { sqlNow } from "./db.js";
import { findCounty, normalizePhone } from "./geo.js";

export class ValidationError extends Error {
  constructor(errors) {
    super(errors.join("; "));
    this.status = 400;
    this.errors = errors;
  }
}

export const LANGUAGES = ["en", "kpe", "bsq", "kss"]; // Liberian English, Kpelle, Bassa, Kissi
export const CHANNELS = ["app", "ussd", "sms", "voice", "assisted"];

/** Check and clean registration input. Throws ValidationError. */
export function cleanFarmerInput(input, content) {
  const errors = [];
  const phone = normalizePhone(input.phone);
  if (!phone) errors.push("phone: not a valid Liberian mobile number");
  const county = findCounty(input.county);
  if (!county) errors.push("county: must be one of Liberia's 15 counties");
  const language = input.language ?? "en";
  if (!LANGUAGES.includes(language)) errors.push(`language: must be one of ${LANGUAGES.join(", ")}`);
  const channel = input.channel ?? "app";
  if (!CHANNELS.includes(channel)) errors.push(`channel: must be one of ${CHANNELS.join(", ")}`);
  if (input.consent !== true) errors.push("consent: the farmer must agree to receive messages (consent: true)");

  const crops = [];
  if (!Array.isArray(input.crops) || input.crops.length === 0) errors.push("crops: list at least one crop");
  else {
    for (const c of input.crops) {
      if (!content.crops.has(c?.crop)) errors.push(`crops: unknown crop "${c?.crop}" (known: ${[...content.crops.keys()].join(", ")})`);
      else if (!Number.isInteger(c.planting_month) || c.planting_month < 1 || c.planting_month > 12) errors.push(`crops: planting_month for ${c.crop} must be 1-12`);
      else if (crops.some((x) => x.crop === c.crop)) errors.push(`crops: ${c.crop} listed twice`);
      else crops.push({ crop: c.crop, planting_month: c.planting_month });
    }
  }
  if (errors.length) throw new ValidationError(errors);

  return {
    phone,
    name: typeof input.name === "string" ? input.name.trim().slice(0, 80) || null : null,
    county,
    district: typeof input.district === "string" ? input.district.trim().slice(0, 80) || null : null,
    language,
    channel,
    registered_by: input.registered_by ? normalizePhone(input.registered_by) : null,
    crops
  };
}

export async function createFarmer(db, farmer) {
  return db.tx(async (t) => {
    const { id } = await t.get(
      `INSERT INTO farmers (phone, name, county, district, language, channel, registered_by, consent_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?) RETURNING id`,
      farmer.phone, farmer.name, farmer.county, farmer.district, farmer.language, farmer.channel, farmer.registered_by, sqlNow()
    );
    for (const c of farmer.crops) await t.run("INSERT INTO farmer_crops (farmer_id, crop, planting_month) VALUES (?, ?, ?)", id, c.crop, c.planting_month);
    return getFarmer(t, id);
  });
}

async function withCrops(db, row) {
  if (!row) return null;
  const crops = await db.all("SELECT crop, planting_month FROM farmer_crops WHERE farmer_id = ? ORDER BY crop", row.id);
  return { ...row, crops };
}

export async function getFarmer(db, id) {
  return withCrops(db, await db.get("SELECT * FROM farmers WHERE id = ?", id));
}

export async function getFarmerByPhone(db, phone) {
  const p = normalizePhone(phone);
  return p ? withCrops(db, await db.get("SELECT * FROM farmers WHERE phone = ?", p)) : null;
}

/** counties: limit to these counties (an officer's area); undefined = all. */
export async function listFarmers(db, { county, counties, limit = 100, offset = 0 } = {}) {
  const list = counties ?? (county ? [county] : null);
  const rows = list
    ? await db.all(`SELECT * FROM farmers WHERE county IN (${list.map(() => "?").join(",") || "NULL"}) ORDER BY id DESC LIMIT ? OFFSET ?`, ...list, limit, offset)
    : await db.all("SELECT * FROM farmers ORDER BY id DESC LIMIT ? OFFSET ?", limit, offset);
  return Promise.all(rows.map((r) => withCrops(db, r)));
}

export async function countFarmersByCounty(db) {
  return db.all("SELECT county, COUNT(*) AS farmers FROM farmers WHERE opted_out_at IS NULL GROUP BY county ORDER BY farmers DESC, county");
}

export async function setLanguage(db, farmerId, language) {
  if (!LANGUAGES.includes(language)) throw new ValidationError([`language: must be one of ${LANGUAGES.join(", ")}`]);
  await db.run("UPDATE farmers SET language = ? WHERE id = ?", language, farmerId);
  return getFarmer(db, farmerId);
}

/** STOP / START: opted-out farmers get no push messages, but can still use USSD. */
export async function setOptedOut(db, farmerId, optedOut) {
  await db.run("UPDATE farmers SET opted_out_at = ? WHERE id = ?", optedOut ? sqlNow() : null, farmerId);
  return getFarmer(db, farmerId);
}
