// Incoming SMS from farmers. Keywords (not case-sensitive):
//   STOP          stop push advice
//   START         turn advice back on
//   HELP          how to use AgriConnect
//   ASK <text>    send a question to an extension officer
//   WEATHER       the forecast and farm advice for the farmer's county
//   PRICES <mkt>  latest market prices (e.g. PRICES GBARNGA)
//   PRICE <mkt> <item> <LRD>   market reporters only: report a price (PRICE GBARNGA RICE 45)
// Anything else gets the HELP reply.
import { normalizePhone } from "./geo.js";
import { getFarmerByPhone, setOptedOut } from "./farmers.js";
import { createQuestion } from "./questions.js";
import { logInbound, sendSms } from "./messaging.js";
import { getForecast } from "./weather.js";
import { recordPrice, latestPrices, findMarket, getReporter, priceText } from "./prices.js";

const HELP =
  "AgriConnect: dial *347# for advice. SMS: ASK + question, WEATHER, PRICES GBARNGA. Reply STOP to stop. All free.";

export async function handleInboundSms(ctx, { from, text }) {
  const { db } = ctx;
  const phone = normalizePhone(from);
  if (!phone) return { ok: false, error: "Unknown sender" };
  const farmer = await getFarmerByPhone(db, phone);
  const body = String(text ?? "").trim();
  await logInbound(db, { phone, farmerId: farmer?.id ?? null, body });

  const [keyword, ...rest] = body.split(/\s+/);
  const word = (keyword ?? "").toUpperCase();
  let reply;

  if (word === "STOP") {
    if (farmer) await setOptedOut(db, farmer.id, true);
    reply = "You will not get AgriConnect advice by SMS any more. Reply START to turn it back on.";
  } else if (word === "START") {
    if (farmer) {
      await setOptedOut(db, farmer.id, false);
      reply = "Welcome back! AgriConnect farm advice is ON again.";
    } else reply = "You are not registered yet. Dial *347# and choose 1 to register for free farm advice.";
  } else if (word === "ASK" && rest.length) {
    const question = rest.join(" ").slice(0, 500);
    const q = await createQuestion(db, { farmer, phone, kind: "text", body: question, channel: "sms" });
    reply = farmer
      ? `Thank you. Your question is with an extension officer in ${farmer.county}. Ref Q-${q.id}. We will reply by SMS.`
      : `Thank you. Ref Q-${q.id}. An officer will reply. To get advice for your county, dial *347# and register.`;
  } else if (word === "WEATHER") {
    const f = farmer ? await getForecast(db, farmer.county, ctx.now()) : null;
    reply = !farmer ? "Register first: dial *347# and choose 1. Then SMS WEATHER for your county's forecast."
      : f ? `${farmer.county}: ${f.advice.text}`.slice(0, 160)
      : `No forecast for ${farmer.county} yet. Please try again later.`;
  } else if ((word === "PRICE" || word === "PRICES") && rest.length === 3) {
    const reporter = await getReporter(db, phone);
    if (!reporter) reply = "Only registered market reporters can send prices. To see prices, SMS PRICES and the market, e.g. PRICES GBARNGA";
    else {
      try {
        const p = await recordPrice(ctx, { market: rest[0], item: rest[1], price: rest[2].replace(/[^\d.]/g, ""), reporter: phone });
        reply = p.status === "ok"
          ? `Thank you. Saved: ${p.item_name} ${p.price_lrd} LRD/${p.unit} at ${p.market_name}.`
          : `Saved, but ${p.price_lrd} LRD is very different from last week, so an officer will check it first. Send again if it was a mistake.`;
      } catch (err) {
        reply = `Not saved. ${err.errors?.[0] ?? err.message}`.slice(0, 160);
      }
    }
  } else if (word === "PRICE" || word === "PRICES") {
    const market = rest[0] ? findMarket(ctx.content, rest[0]) : ctx.content.markets.find((m) => m.county === farmer?.county);
    const list = market ? await latestPrices(ctx, market.id) : null;
    reply = list ? priceText(list) : `SMS PRICES and a market: ${ctx.content.markets.map((m) => m.code).join(", ")}`.slice(0, 160);
  } else {
    reply = HELP;
  }

  const sent = await sendSms(db, { phone, farmerId: farmer?.id ?? null, body: reply, force: true }); // a reply to the farmer's own message is always sent
  return { ok: true, reply, message_id: sent.id };
}
