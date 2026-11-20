// Incoming SMS from farmers. Keywords (not case-sensitive):
//   STOP          stop push advice
//   START         turn advice back on
//   HELP          how to use AgriConnect
//   ASK <text>    send a question to an extension officer
// Anything else gets the HELP reply.
import { normalizePhone } from "./geo.js";
import { getFarmerByPhone, setOptedOut } from "./farmers.js";
import { createQuestion } from "./questions.js";
import { logInbound, sendSms } from "./messaging.js";

const HELP =
  "AgriConnect: dial *347# for farm advice and to report pests. SMS ASK + your question to reach an officer. Reply STOP to stop. All free.";

export function handleInboundSms(ctx, { from, text }) {
  const { db } = ctx;
  const phone = normalizePhone(from);
  if (!phone) return { ok: false, error: "Unknown sender" };
  const farmer = getFarmerByPhone(db, phone);
  const body = String(text ?? "").trim();
  logInbound(db, { phone, farmerId: farmer?.id ?? null, body });

  const [keyword, ...rest] = body.split(/\s+/);
  const word = (keyword ?? "").toUpperCase();
  let reply;

  if (word === "STOP") {
    if (farmer) setOptedOut(db, farmer.id, true);
    reply = "You will not get AgriConnect advice by SMS any more. Reply START to turn it back on.";
  } else if (word === "START") {
    if (farmer) {
      setOptedOut(db, farmer.id, false);
      reply = "Welcome back! AgriConnect farm advice is ON again.";
    } else reply = "You are not registered yet. Dial *347# and choose 1 to register for free farm advice.";
  } else if (word === "ASK" && rest.length) {
    const question = rest.join(" ").slice(0, 500);
    const q = createQuestion(db, { farmer, phone, kind: "text", body: question, channel: "sms" });
    reply = farmer
      ? `Thank you. Your question is with an extension officer in ${farmer.county}. Ref Q-${q.id}. We will reply by SMS.`
      : `Thank you. Ref Q-${q.id}. An officer will reply. To get advice for your county, dial *347# and register.`;
  } else {
    reply = HELP;
  }

  const sent = sendSms(db, { phone, farmerId: farmer?.id ?? null, body: reply, force: true }); // a reply to the farmer's own message is always sent
  return { ok: true, reply, message_id: sent.id };
}
