// Broadcasts: an officer sends one advisory to every matching farmer.
// Targets farmers who have not said STOP, in the chosen counties (none = all)
// and growing any of the chosen crops (none = all crops).
import { ValidationError } from "./farmers.js";
import { findCounty } from "./geo.js";
import { SMS_LIMIT } from "./content.js";

// sms: an SMS to every matching farmer. app: shown on the farmer app's home screen only (no SMS cost).
// Every advisory also appears in the app, so "sms" reaches app users too. Voice calls come later.
export const BROADCAST_CHANNELS = ["sms", "app"];

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
  for (const ch of channels) {
    if (ch === "voice") errors.push("channels: voice calls are not available yet");
    else if (!BROADCAST_CHANNELS.includes(ch)) errors.push(`channels: unknown channel "${ch}"`);
  }
  const message = typeof input.message === "string" ? input.message.trim() : "";
  if (input.requireMessage !== false) {
    if (!message) errors.push("message: write the advisory");
    else if (message.length > SMS_LIMIT) errors.push(`message: ${message.length} characters (max ${SMS_LIMIT} for one SMS)`);
  }
  if (errors.length) throw new ValidationError(errors);
  return { counties, crops, channels, message, sent_by: typeof input.sent_by === "string" ? input.sent_by.slice(0, 80) : null };
}

/** Farmers who would receive this broadcast. */
export async function findRecipients(db, { counties, crops }) {
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
  return db.all(`SELECT f.id, f.phone FROM farmers f WHERE ${where.join(" AND ")} ORDER BY f.id`, ...args);
}

export async function previewBroadcast(db, content, input) {
  const target = cleanBroadcastInput({ ...input, requireMessage: false }, content);
  return { reach: (await findRecipients(db, target)).length, counties: target.counties, crops: target.crops };
}

export async function sendBroadcast(db, content, input) {
  const b = cleanBroadcastInput(input, content);
  return db.tx(async (t) => {
    const recipients = await findRecipients(t, b);
    // reach = the farmers it is meant for (all of them see it in the app).
    const { id } = await t.get(
      "INSERT INTO broadcasts (counties, crops, channels, message, sent_by, reach) VALUES (?, ?, ?, ?, ?, ?) RETURNING id",
      JSON.stringify(b.counties), JSON.stringify(b.crops), JSON.stringify(b.channels), b.message, b.sent_by, recipients.length
    );
    // SMS are queued here; the background sender delivers them (see messaging.js).
    let queued = 0;
    if (b.channels.includes("sms")) {
      // Written 500 at a time: a 10,000-farmer advisory is queued in about a second.
      // (findRecipients already left out farmers who said STOP, in this same transaction.)
      for (let i = 0; i < recipients.length; i += 500) {
        const chunk = recipients.slice(i, i + 500);
        await t.run(
          `INSERT INTO message_log (farmer_id, phone, channel, direction, body, status, kind, broadcast_id)
           VALUES ${chunk.map(() => "(?, ?, 'sms', 'out', ?, 'queued', 'broadcast', ?)").join(", ")}`,
          ...chunk.flatMap((r) => [r.id, r.phone, b.message, id])
        );
        queued += chunk.length;
      }
    }
    return { ...(await getBroadcast(t, id)), recipients: recipients.length, queued };
  });
}

function parse(row) {
  return row
    ? { ...row, counties: JSON.parse(row.counties), crops: JSON.parse(row.crops), channels: JSON.parse(row.channels) }
    : null;
}

/**
 * SMS delivery for each advisory: { queued, sending, sent, delivered, failed, total, delivery_rate }.
 * delivery_rate = delivered ÷ total once delivery reports come back (the MVP target is 95%).
 */
async function withDelivery(db, list) {
  if (!list.length) return list;
  const rows = await db.all(
    `SELECT broadcast_id, status, COUNT(*) AS n FROM message_log WHERE broadcast_id IN (${list.map(() => "?").join(",")}) GROUP BY broadcast_id, status`,
    ...list.map((b) => b.id)
  );
  return list.map((b) => {
    const sms = { queued: 0, sending: 0, sent: 0, delivered: 0, failed: 0, total: 0 };
    for (const r of rows) if (r.broadcast_id === b.id || Number(r.broadcast_id) === b.id) { sms[r.status] = (sms[r.status] ?? 0) + Number(r.n); sms.total += Number(r.n); }
    return { ...b, sms: b.channels.includes("sms") ? { ...sms, delivery_rate: sms.total ? sms.delivered / sms.total : null } : null };
  });
}

export async function getBroadcast(db, id) {
  const b = parse(await db.get("SELECT * FROM broadcasts WHERE id = ?", id));
  return b ? (await withDelivery(db, [b]))[0] : null;
}

export async function listBroadcasts(db, { limit = 20 } = {}) {
  return withDelivery(db, (await db.all("SELECT * FROM broadcasts ORDER BY id DESC LIMIT ?", limit)).map(parse));
}
