// Farmer data access: shared by the REST API now and the USSD/SMS handlers in step 2.
import { transaction } from "./db.js";
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

export function createFarmer(db, farmer) {
  return transaction(db, () => {
    const { lastInsertRowid } = db
      .prepare(`INSERT INTO farmers (phone, name, county, district, language, channel, registered_by, consent_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now'))`)
      .run(farmer.phone, farmer.name, farmer.county, farmer.district, farmer.language, farmer.channel, farmer.registered_by);
    const addCrop = db.prepare("INSERT INTO farmer_crops (farmer_id, crop, planting_month) VALUES (?, ?, ?)");
    for (const c of farmer.crops) addCrop.run(lastInsertRowid, c.crop, c.planting_month);
    return getFarmer(db, Number(lastInsertRowid));
  });
}

function withCrops(db, row) {
  if (!row) return null;
  const crops = db.prepare("SELECT crop, planting_month FROM farmer_crops WHERE farmer_id = ? ORDER BY crop").all(row.id);
  return { ...row, crops: crops.map((c) => ({ ...c })) };
}

export function getFarmer(db, id) {
  return withCrops(db, db.prepare("SELECT * FROM farmers WHERE id = ?").get(id));
}

export function getFarmerByPhone(db, phone) {
  const p = normalizePhone(phone);
  return p ? withCrops(db, db.prepare("SELECT * FROM farmers WHERE phone = ?").get(p)) : null;
}

export function listFarmers(db, { county, limit = 100, offset = 0 } = {}) {
  const rows = county
    ? db.prepare("SELECT * FROM farmers WHERE county = ? ORDER BY id DESC LIMIT ? OFFSET ?").all(county, limit, offset)
    : db.prepare("SELECT * FROM farmers ORDER BY id DESC LIMIT ? OFFSET ?").all(limit, offset);
  return rows.map((r) => withCrops(db, r));
}

export function countFarmersByCounty(db) {
  return db.prepare("SELECT county, COUNT(*) AS farmers FROM farmers WHERE opted_out_at IS NULL GROUP BY county ORDER BY farmers DESC").all().map((r) => ({ ...r }));
}
