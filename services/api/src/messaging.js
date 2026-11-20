// Outbound SMS go through a queue:
//
//   sendSms()        writes the message to message_log with status "queued" (instant, never blocks)
//   deliverQueued()  the background sender hands queued messages to the SMS provider,
//                    retrying failures up to MAX_ATTEMPTS times with growing waits
//   markDelivery()   the provider's delivery report updates the status to delivered / failed
//
// So a broadcast to 10,000 farmers returns at once, and a provider outage only delays messages.
import { SMS_LIMIT } from "./content.js";

export const MAX_ATTEMPTS = 3;
export const KINDS = ["reply", "welcome", "advice", "broadcast", "alert", "weather"];

export class MessageTooLongError extends Error {}

/**
 * Queue one SMS. Returns the queued message, or { skipped: "opted_out" }.
 * force: send even if the farmer said STOP. Only for replies to something the farmer
 * just did (their own SMS, USSD request, report or question), never for push messages.
 */
export async function sendSms(db, { phone, farmerId = null, body, force = false, kind = "reply" }) {
  if (body.length > SMS_LIMIT) throw new MessageTooLongError(`SMS is ${body.length} characters (max ${SMS_LIMIT}): ${body}`);
  if (!force && farmerId != null) {
    const row = await db.get("SELECT opted_out_at FROM farmers WHERE id = ?", farmerId);
    if (row?.opted_out_at) return { skipped: "opted_out" };
  }
  const { id } = await db.get(
    "INSERT INTO message_log (farmer_id, phone, channel, direction, body, status, kind) VALUES (?, ?, 'sms', 'out', ?, 'queued', ?) RETURNING id",
    farmerId, phone, body, KINDS.includes(kind) ? kind : "reply"
  );
  return getMessage(db, id);
}

/**
 * Send up to `limit` queued messages through the provider. Safe to call often, and safe with
 * several servers: each message is claimed (queued → sending) before it is sent.
 * Returns { sent, retrying, failed }.
 */
export async function deliverQueued(db, provider, { limit = 50, now = new Date() } = {}) {
  const nowIso = now.toISOString();
  const due = await db.all(
    `SELECT * FROM message_log
      WHERE direction = 'out' AND channel = 'sms' AND status = 'queued'
        AND (next_attempt_at IS NULL OR next_attempt_at <= ?)
      ORDER BY id LIMIT ?`,
    nowIso, limit
  );
  const summary = { sent: 0, retrying: 0, failed: 0 };
  for (const m of due) {
    const claimed = await db.run("UPDATE message_log SET status = 'sending' WHERE id = ? AND status = 'queued'", m.id);
    if (!claimed.changes) continue;
    let result;
    try {
      result = await provider.send({ to: m.phone, body: m.body });
    } catch (err) {
      result = { ok: false, error: err.message, retry: true };
    }
    const attempts = m.attempts + 1;
    if (result.ok) {
      await db.run("UPDATE message_log SET status = 'sent', attempts = ?, provider_id = ?, sent_at = ?, last_error = NULL WHERE id = ?",
        attempts, result.id ?? null, nowIso, m.id);
      summary.sent++;
    } else if (result.retry && attempts < MAX_ATTEMPTS) {
      const wait = 2 ** attempts * 60 * 1000; // 2 min, then 4 min
      await db.run("UPDATE message_log SET status = 'queued', attempts = ?, last_error = ?, next_attempt_at = ? WHERE id = ?",
        attempts, String(result.error).slice(0, 300), new Date(now.getTime() + wait).toISOString(), m.id);
      summary.retrying++;
    } else {
      await db.run("UPDATE message_log SET status = 'failed', attempts = ?, last_error = ? WHERE id = ?", attempts, String(result.error).slice(0, 300), m.id);
      summary.failed++;
    }
  }
  return summary;
}

/** After a crash, messages stuck in "sending" go back to the queue. */
export async function requeueStuck(db) {
  return (await db.run("UPDATE message_log SET status = 'queued' WHERE status = 'sending'")).changes;
}

/** Delivery report from the provider. Accepts the common wordings. */
export async function markDelivery(db, providerId, providerStatus) {
  if (!providerId) return false;
  const s = String(providerStatus ?? "").toLowerCase();
  const status = ["success", "delivered", "delivrd"].includes(s) ? "delivered"
    : ["failed", "rejected", "undelivered", "expired", "undeliv"].includes(s) ? "failed"
    : null;
  if (!status) return false;
  const r = await db.run("UPDATE message_log SET status = ?, last_error = ? WHERE provider_id = ? AND direction = 'out'",
    status, status === "failed" ? `delivery report: ${providerStatus}` : null, String(providerId));
  return r.changes > 0;
}

export async function logInbound(db, { phone, farmerId = null, channel = "sms", body }) {
  await db.run("INSERT INTO message_log (farmer_id, phone, channel, direction, body, status) VALUES (?, ?, ?, 'in', ?, 'received')",
    farmerId, phone, channel, body);
}

export async function getMessage(db, id) {
  return (await db.get("SELECT * FROM message_log WHERE id = ?", id)) ?? null;
}

export async function listMessages(db, { phone, status, limit = 50 } = {}) {
  const where = [];
  const args = [];
  if (phone) { where.push("phone = ?"); args.push(phone); }
  if (status) { where.push("status = ?"); args.push(status); }
  return db.all(`SELECT * FROM message_log ${where.length ? "WHERE " + where.join(" AND ") : ""} ORDER BY id DESC LIMIT ?`, ...args, limit);
}

export async function messageStats(db) {
  const rows = await db.all("SELECT status, COUNT(*) AS n FROM message_log WHERE direction = 'out' GROUP BY status");
  const by = Object.fromEntries(rows.map((r) => [r.status, r.n]));
  return {
    queued: (by.queued ?? 0) + (by.sending ?? 0),
    sent: (by.sent ?? 0) + (by.delivered ?? 0),
    delivered: by.delivered ?? 0,
    failed: by.failed ?? 0
  };
}
