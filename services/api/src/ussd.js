// USSD menus for *347#. Works on any phone, no internet needed.
//
// How USSD gateways talk to us (the common "CON / END" format used by most
// African aggregators): every time the farmer presses SEND, the gateway POSTs
//   phoneNumber = "+231777123456"
//   text        = everything typed so far in this session, joined by "*"  e.g. "1*2*5"
// We reply with plain text that starts with
//   "CON " = show this screen and wait for the next answer, or
//   "END " = show this screen and close the session.
// Because "text" holds the whole session, this handler keeps no session state:
// it replays the answers from the start each time.
//
// Every screen must fit in USSD_MAX characters. Reserved keys on every screen:
// 0 = back, 00 = main menu.
import { COUNTIES, normalizePhone } from "./geo.js";
import { adviceForFarmer } from "./engine.js";
import { createFarmer, getFarmerByPhone, setLanguage, setOptedOut } from "./farmers.js";
import { createPestReport } from "./pestReports.js";
import { createQuestion } from "./questions.js";
import { sendSms } from "./messaging.js";
import { sendAdviceToFarmer } from "./scheduler.js";
import { getForecast, shortForecast } from "./weather.js";
import { latestPrices, priceText } from "./prices.js";
import { isUniqueViolation } from "./db.js";
import { waitingRegistration, answerRegistration } from "./registrations.js";

export const USSD_MAX = 182;

const LANGUAGE_OPTIONS = [
  { label: "Liberian English", value: "en" },
  { label: "Kpelle", value: "kpe" },
  { label: "Bassa", value: "bsq" },
  { label: "Kissi", value: "kss" }
];
const LANGUAGE_NAMES = Object.fromEntries(LANGUAGE_OPTIONS.map((l) => [l.value, l.label]));
const MONTHS = "1Jan 2Feb 3Mar 4Apr 5May 6Jun\n7Jul 8Aug 9Sep 10Oct 11Nov 12Dec";
const COUNTY_PAGE_1 = COUNTIES.slice(0, 7);
const COUNTY_PAGE_2 = COUNTIES.slice(7);

const con = (text) => ({ type: "CON", text });
const end = (text) => ({ type: "END", text });

/** Thrown when the farmer has not answered a screen yet: that screen is what we show. */
class NeedInput {
  constructor(reply) { this.reply = reply; }
}

/** Turn "1*2*0*3*00*4" into the answers that still count, applying 0 (back) and 00 (main menu). */
export function normalizeInputs(text) {
  const answers = [];
  for (const raw of String(text ?? "").split("*")) {
    const v = raw.trim();
    if (v === "") continue;
    if (v === "00") answers.length = 0;
    else if (v === "0") answers.pop();
    else answers.push(v);
  }
  return answers;
}

/** Replays the farmer's answers screen by screen. ask() returns an answer or stops with a prompt. */
function session(answers) {
  let i = 0;
  return {
    ask(prompt, parse) {
      let retry = "";
      for (;;) {
        if (i >= answers.length) throw new NeedInput(con(retry + prompt));
        const value = parse(answers[i++]);
        if (value !== undefined && value !== null) return value;
        retry = "Try again.\n";
      }
    },
    choose(title, options) {
      const lines = options.map((o, n) => `${n + 1} ${o.label}`).join("\n");
      return this.ask(`${title}\n${lines}`, (v) => options[Number(v) - 1]?.value);
    }
  };
}

function askCounty(s) {
  const page1 = `Your county:\n${COUNTY_PAGE_1.map((c, n) => `${n + 1} ${c}`).join("\n")}\n8 More`;
  const first = s.ask(page1, (v) => (v === "8" ? "MORE" : COUNTY_PAGE_1[Number(v) - 1]));
  if (first !== "MORE") return first;
  const page2 = `Your county:\n${COUNTY_PAGE_2.map((c, n) => `${n + 1} ${c}`).join("\n")}`;
  return s.ask(page2, (v) => COUNTY_PAGE_2[Number(v) - 1]);
}

// ---------------------------------------------------------------- flows

async function register(ctx, s, phone) {
  const { db, content } = ctx;
  const language = s.choose("Choose language:", LANGUAGE_OPTIONS);
  const county = askCounty(s);

  const cropList = [...content.crops.values()];
  const cropOptions = cropList.map((c) => ({ label: c.name, value: [c.id] }));
  if (cropList.length > 1) cropOptions.push({ label: "All of these", value: cropList.map((c) => c.id) });
  const cropIds = s.choose("Your main crop:", cropOptions);

  const crops = cropIds.map((id) => ({
    crop: id,
    planting_month: s.ask(`Month you plant ${content.crops.get(id).name.toUpperCase()}?\n${MONTHS}`, (v) => {
      const m = Number(v);
      return Number.isInteger(m) && m >= 1 && m <= 12 ? m : undefined;
    })
  }));

  const agree = s.choose("AgriConnect sends free farm advice by SMS. Your number stays private. Reply STOP anytime.", [
    { label: "I agree", value: "yes" },
    { label: "Cancel", value: "no" }
  ]);
  if (agree !== "yes") return end("Registration cancelled. Dial *347# anytime to join.");

  let farmer;
  try {
    farmer = await createFarmer(db, { phone, name: null, county, district: null, language, channel: "ussd", registered_by: null, crops });
  } catch (err) {
    // The same phone registered a moment ago (e.g. the gateway sent the last answer twice).
    if (isUniqueViolation(err)) return end("You are already registered. Dial *347# for the full menu.");
    throw err;
  }
  await sendSms(db, {
    phone,
    farmerId: farmer.id,
    body: `Welcome to AgriConnect! You are registered in ${county} County. Farm advice is free. Reply STOP to stop. Dial *347# for help.`,
    kind: "welcome"
  });
  // Send this week's advice straight away so the farmer sees value on day one.
  // (Recorded like the daily job's advice, so the farmer does not get it twice.)
  await sendAdviceToFarmer(ctx, farmer);
  return end("Thank you! You are registered.\nCheck your SMS for your first farm advice.");
}

async function cropAdvice(ctx, s, farmer) {
  const { db, content, now } = ctx;
  const advice = adviceForFarmer(farmer, content, now());
  const pick =
    advice.length === 1
      ? advice[0]
      : s.choose("Which crop?", advice.map((a) => ({ label: content.crops.get(a.crop)?.name ?? a.crop, value: a })));
  if (!pick.message) {
    const name = content.crops.get(pick.crop)?.name ?? pick.crop;
    return end(`No ${name} advice this week (between seasons). We will SMS you when your season starts.`);
  }
  s.ask(`${pick.message}\n1 Get by SMS`, (v) => (v === "1" ? true : undefined));
  await sendSms(db, { phone: farmer.phone, farmerId: farmer.id, body: pick.message, force: true });
  return end("Sent! Check your SMS.");
}

async function reportPest(ctx, s, phone, farmer) {
  const { db, content } = ctx;
  const symptoms = s.choose("What do you see?", content.ussdSymptoms.map((o) => ({ label: o.label, value: o.symptoms })));
  const crop = s.choose("Which crop?", content.reportCrops.map((c) => ({ label: c.label, value: c.id })));
  const county = farmer ? farmer.county : askCounty(s);
  const result = await createPestReport(db, content, { phone, county, crop, symptoms, channel: "ussd" });
  await sendSms(db, { phone, farmerId: farmer?.id ?? null, body: result.reply_sms, force: true });
  return end(`Report sent. Ref ${result.ref}.\nAdvice is coming by SMS. An extension officer will follow up.`);
}

async function askExpert(ctx, s, phone, farmer) {
  const how = s.choose("Ask an expert (free):", [
    { label: "Request a call-back", value: "callback" },
    { label: "Ask by SMS", value: "sms" }
  ]);
  if (how === "sms") return end("Send an SMS that starts with ASK, for example:\nASK my pepper leaves are turning yellow\nIt is free.");
  const county = farmer ? farmer.county : askCounty(s);
  const q = await createQuestion(ctx.db, { farmer, phone, county, kind: "callback", channel: "ussd" });
  return end(`Request received (Ref Q-${q.id}).\nAn extension officer in ${county} will call you within 24 hours.`);
}

async function profile(ctx, s, farmer) {
  const { db, content } = ctx;
  const crops = farmer.crops.map((c) => content.crops.get(c.crop)?.name ?? c.crop).join(", ");
  const smsOn = !farmer.opted_out_at;
  const action = s.choose(
    `Your profile:\n${farmer.county} County\nCrops: ${crops}\nLanguage: ${LANGUAGE_NAMES[farmer.language] ?? farmer.language}\nSMS advice: ${smsOn ? "ON" : "OFF"}`,
    [
      { label: "Change language", value: "language" },
      { label: smsOn ? "Stop SMS advice" : "Start SMS advice", value: "sms" }
    ]
  );
  if (action === "language") {
    const language = s.choose("Choose language:", LANGUAGE_OPTIONS);
    await setLanguage(db, farmer.id, language);
    return end(`Language changed to ${LANGUAGE_NAMES[language]}.`);
  }
  await setOptedOut(db, farmer.id, smsOn);
  return end(smsOn ? "SMS advice stopped. Dial *347# and choose 6 to start again." : "SMS advice is ON again. Welcome back!");
}

async function weather(ctx, s, farmer) {
  const f = await getForecast(ctx.db, farmer.county, ctx.now());
  if (!f) return end(`No forecast for ${farmer.county} yet. Please try again later.`);
  const footer = "\n1 Get by SMS";
  let screen = "";
  for (const n of [3, 2, 1]) {
    screen = `${shortForecast(f.days, n)}\n${f.advice.text}`;
    if (screen.length + footer.length <= USSD_MAX) break;
  }
  s.ask((screen + footer).slice(0, USSD_MAX), (v) => (v === "1" ? true : undefined));
  await sendSms(ctx.db, { phone: farmer.phone, farmerId: farmer.id, body: `${farmer.county}: ${f.advice.text}`.slice(0, 160), force: true });
  return end("Sent! Check your SMS.");
}

async function prices(ctx, s, farmer) {
  const markets = ctx.content.markets;
  const mine = markets.findIndex((m) => m.county === farmer.county);
  const ordered = mine > 0 ? [markets[mine], ...markets.filter((_, i) => i !== mine)] : markets;
  const market = s.choose("Which market?", ordered.map((m) => ({ label: m.name, value: m.id })));
  const list = await latestPrices(ctx, market);
  if (!list.items.length) return end(`${list.market_name}: no prices this week yet. Try another market.`);
  s.ask(`${priceText(list, USSD_MAX - 13)}\n1 Get by SMS`, (v) => (v === "1" ? true : undefined));
  await sendSms(ctx.db, { phone: farmer.phone, farmerId: farmer.id, body: priceText(list, 160), force: true });
  return end("Sent! Check your SMS.");
}

// ---------------------------------------------------------------- entry point

/** Handle one USSD request. Returns { type: "CON" | "END", text }. */
export async function handleUssd(ctx, { phoneNumber, text }) {
  const phone = normalizePhone(phoneNumber);
  if (!phone) return end("Sorry, AgriConnect is for Liberian mobile numbers.");
  const s = session(normalizeInputs(text));
  try {
    const farmer = await getFarmerByPhone(ctx.db, phone);
    if (!farmer) {
      // Someone registered this farmer for them: ask for their consent first.
      const invite = await waitingRegistration(ctx.db, phone, ctx.now());
      if (invite) {
        const crops = invite.details.crops.map((c) => ctx.content.crops.get(c.crop)?.name.split(" ")[0] ?? c.crop).join(" & ");
        const yes = s.choose(`${(invite.registrar_name ?? "An officer").slice(0, 22)} registered you for free ${crops} advice in ${invite.county}. Join?`, [
          { label: "Yes, join (free)", value: true },
          { label: "No", value: false }
        ]);
        const answer = await answerRegistration(ctx, phone, yes);
        return answer.status === "joined"
          ? end("Welcome! You are registered.\nCheck your SMS for your first farm advice.")
          : end("OK. You are not registered. Dial *347# if you change your mind.");
      }
      const choice = s.choose("Welcome to AgriConnect Liberia. Free farm advice.", [
        { label: "Register (free)", value: "register" },
        { label: "Report pest or disease", value: "pest" },
        { label: "Ask an expert", value: "ask" }
      ]);
      if (choice === "register") return await register(ctx, s, phone);
      if (choice === "pest") return await reportPest(ctx, s, phone, null);
      return await askExpert(ctx, s, phone, null);
    }
    const choice = s.choose(`AgriConnect - ${farmer.county}`, [
      { label: "Crop advice", value: "advice" },
      { label: "Weather", value: "weather" },
      { label: "Market prices", value: "prices" },
      { label: "Report pest or disease", value: "pest" },
      { label: "Ask an expert", value: "ask" },
      { label: "My profile", value: "profile" }
    ]);
    switch (choice) {
      case "advice": return await cropAdvice(ctx, s, farmer);
      case "weather": return await weather(ctx, s, farmer);
      case "prices": return await prices(ctx, s, farmer);
      case "pest": return await reportPest(ctx, s, phone, farmer);
      case "ask": return await askExpert(ctx, s, phone, farmer);
      default: return await profile(ctx, s, farmer);
    }
  } catch (err) {
    if (err instanceof NeedInput) return err.reply;
    throw err;
  }
}
