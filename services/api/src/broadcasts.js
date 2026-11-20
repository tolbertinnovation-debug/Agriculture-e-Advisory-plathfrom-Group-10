// Broadcasts: an officer sends one advisory to every matching farmer.
// Targets farmers who have not said STOP, in the chosen counties (none = all)
// and growing any of the chosen crops (none = all crops).
import { ValidationError } from "./farmers.js";
import { findCounty } from "./geo.js";
import { sendSms } from "./messaging.js";
import { SMS_LIMIT } from "./content.js";
import { transaction } from "./db.js";

export const BROADCAST_CHANNELS = ["sms", "voice", "app"]; // only sms is delivered for now

export function cleanBroadcastInput(input, content) {
  const errors = [];
  const counties = [];
  for (const c of input.counties ?? []) {
    const county = findCounty(c);
    if (!county) errors.push(`counties: unknown county "${c}"`);
    else counties.push(county);
  }
  const crops = [];
  for (const c of input.crops ?? []) {
    if (!content.crops.has(c)) errors.push(`crops: unknown crop "${c}"`);
    else crops.push(c);
  }
  const channels = input.channels?.length ? input.channels : ["sms"];
  for (const ch of channels) if (!BROADCAST_CHANNELS.includes(ch)) errors.push(`channels: unknown channel "${ch}"`);
  const message = typeof input.message === "string" ? input.message.trim() : "";
  if (input.requireMessage !== false) {
    if (!message) errors.push("message: write the advisory");
    else if (message.length > SMS_LIMIT) errors.push(`message: ${message.length} characters (max ${SMS_LIMIT} for one SMS)`);
  }
  if (errors.length) throw new ValidationError(errors);
  return { counties, crops, channels, message, sent_by: typeof input.sent_by === "string" ? input.sent_by.slice(0, 80) : null };
}

/** Farmers who would receive this broadcast. */
export function findRecipients(db, { counties, crops }) {
  const where = ["f.opted_out_at IS NULL"];
  const args = [];
  if (counties.length) {
    where.push(`f.county IN (${counties.map(() => "?").join(",")})`);
    args.push(...counties);
  }
  if (crops.length) {
    where.push(`EXISTS (SELECT 1 FROM farmer_crops fc WHERE fc.farmer_id = f.id AND fc.crop IN (${crops.map(() => "?").join(",")}))`);
    args.push(...crops);
  }
  return db.prepare(`SELECT f.id, f.phone FROM farmers f WHERE ${where.join(" AND ")}`).all(...args);
}

export function previewBroadcast(db, content, input) {
  const target = cleanBroadcastInput({ ...input, requireMessage: false }, content);
  return { reach: findRecipients(db, target).length, counties: target.counties, crops: target.crops };
}

export function sendBroadcast(db, content, input) {
  const b = cleanBroadcastInput(input, content);
  const recipients = findRecipients(db, b);
  return transaction(db, () => {
    let delivered = 0;
    if (b.channels.includes("sms")) {
      for (const r of recipients) {
        const sent = sendSms(db, { phone: r.phone, farmerId: r.id, body: b.message });
        if (!sent.skipped) delivered++;
      }
    }
    const { lastInsertRowid } = db
      .prepare("INSERT INTO broadcasts (counties, crops, channels, message, sent_by, reach) VALUES (?, ?, ?, ?, ?, ?)")
      .run(JSON.stringify(b.counties), JSON.stringify(b.crops), JSON.stringify(b.channels), b.message, b.sent_by, delivered);
    return { ...getBroadcast(db, Number(lastInsertRowid)), recipients: recipients.length, delivered };
  });
}

function parse(row) {
  return row
    ? { ...row, counties: JSON.parse(row.counties), crops: JSON.parse(row.crops), channels: JSON.parse(row.channels) }
    : null;
}

export function getBroadcast(db, id) {
  return parse(db.prepare("SELECT * FROM broadcasts WHERE id = ?").get(id));
}

export function listBroadcasts(db, { limit = 20 } = {}) {
  return db.prepare("SELECT * FROM broadcasts ORDER BY id DESC LIMIT ?").all(limit).map(parse);
}
