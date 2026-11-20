// Outbound SMS. Every message is written to message_log first, then handed to a provider.
// For now the provider is "log" (development): nothing leaves the server and the message
// is marked sent, so the USSD simulator can show it in its SMS inbox.
// Step 4 adds a real provider (telco / SMS aggregator) behind the same sendSms() call.
import { SMS_LIMIT } from "./content.js";

const providers = {
  log: () => ({ status: "sent" })
};

export class MessageTooLongError extends Error {}

/**
 * Send one SMS. Returns the logged message, or { skipped: "opted_out" }.
 * force: send even if the farmer said STOP (only for the STOP confirmation itself
 * or for something the farmer asked for directly, like "Get by SMS").
 */
export function sendSms(db, { phone, farmerId = null, body, force = false }) {
  if (body.length > SMS_LIMIT) throw new MessageTooLongError(`SMS is ${body.length} characters (max ${SMS_LIMIT}): ${body}`);
  if (!force && farmerId != null) {
    const row = db.prepare("SELECT opted_out_at FROM farmers WHERE id = ?").get(farmerId);
    if (row?.opted_out_at) return { skipped: "opted_out" };
  }
  const provider = providers[process.env.SMS_PROVIDER ?? "log"] ?? providers.log;
  const { status } = provider({ phone, body });
  const { lastInsertRowid } = db
    .prepare("INSERT INTO message_log (farmer_id, phone, channel, direction, body, status) VALUES (?, ?, 'sms', 'out', ?, ?)")
    .run(farmerId, phone, body, status);
  return getMessage(db, Number(lastInsertRowid));
}

export function logInbound(db, { phone, farmerId = null, channel = "sms", body }) {
  db.prepare("INSERT INTO message_log (farmer_id, phone, channel, direction, body, status) VALUES (?, ?, ?, 'in', ?, 'received')")
    .run(farmerId, phone, channel, body);
}

export function getMessage(db, id) {
  const row = db.prepare("SELECT * FROM message_log WHERE id = ?").get(id);
  return row ? { ...row } : null;
}

export function listMessages(db, { phone, limit = 50 } = {}) {
  const rows = phone
    ? db.prepare("SELECT * FROM message_log WHERE phone = ? ORDER BY id DESC LIMIT ?").all(phone, limit)
    : db.prepare("SELECT * FROM message_log ORDER BY id DESC LIMIT ?").all(limit);
  return rows.map((r) => ({ ...r }));
}
