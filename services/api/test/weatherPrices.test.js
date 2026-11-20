import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { openDb } from "../src/db.js";
import { cleanFarmerInput, createFarmer, setOptedOut } from "../src/farmers.js";
import { parseOpenMeteo, weatherAdvice, refreshWeather, getForecast, sendWeatherAlerts, fetchCountyForecast, COUNTY_POINTS } from "../src/weather.js";
import { recordPrice, latestPrices, addReporter, priceText } from "../src/prices.js";
import { handleUssd, USSD_MAX } from "../src/ussd.js";
import { handleInboundSms } from "../src/smsInbound.js";
import { listMessages } from "../src/messaging.js";
import { validateContent } from "../src/content.js";
import { content, startTestServer } from "./helpers.js";

let clock, ctx;
const DAY = 24 * 3600 * 1000;
beforeEach(() => {
  clock = new Date("2026-06-02T08:00:00Z"); // a Tuesday
  ctx = { db: openDb(":memory:"), content, now: () => clock };
});

/** An Open-Meteo style answer for 5 days from 2026-06-02 with the given rain chances. */
function openMeteo(rain = [80, 90, 30, 20, 10], tmax = [29, 28, 30, 31, 32]) {
  const time = ["2026-06-02", "2026-06-03", "2026-06-04", "2026-06-05", "2026-06-06"];
  return { daily: { time, weather_code: [61, 95, 3, 2, 1], temperature_2m_max: tmax, temperature_2m_min: [23, 23, 24, 24, 24],
    precipitation_sum: rain.map((r) => (r >= 70 ? 25.4 : 1.2)), precipitation_probability_max: rain } };
}
const fakeFetch = (body, calls = []) => {
  const f = async (url) => { calls.push(url); return { ok: true, status: 200, json: async () => body }; };
  f.calls = calls;
  return f;
};
const farmer = (phone, county = "Bong") =>
  createFarmer(ctx.db, cleanFarmerInput({ phone, county, consent: true, crops: [{ crop: "rice", planting_month: 5 }] }, content));

// ---------------------------------------------------------------- weather
test("content includes valid markets and price items", () => {
  assert.deepEqual(validateContent(content), []);
  assert.equal(content.markets.length, 6);
});

test("Open-Meteo answers are parsed into simple days", () => {
  const days = parseOpenMeteo(openMeteo());
  assert.equal(days.length, 5);
  assert.deepEqual(days[0], { date: "2026-06-02", rain_prob: 80, rain_mm: 25.4, t_max: 29, t_min: 23, code: 61 });
  assert.throws(() => parseOpenMeteo({}), /no daily forecast/);
});

test("the request asks Open-Meteo for the county capital, in GMT, 5 days", async () => {
  const f = fakeFetch(openMeteo());
  await fetchCountyForecast("Nimba", { fetch: f });
  const url = new URL(f.calls[0]);
  assert.equal(url.host, "api.open-meteo.com");
  assert.equal(url.searchParams.get("latitude"), "7.36");
  assert.equal(url.searchParams.get("timezone"), "GMT");
  assert.equal(url.searchParams.get("forecast_days"), "5");
});

test("weather advice: heavy rain, hot & dry, and good spraying days", () => {
  const rain = weatherAdvice(parseOpenMeteo(openMeteo()));
  assert.equal(rain.level, "rain");
  assert.match(rain.text, /^Heavy rain Tue & Wed\. Don't spray/);
  assert.match(rain.text, /Wait until Thu\./);
  const dry = weatherAdvice(parseOpenMeteo(openMeteo([5, 10, 5, 0, 10], [33, 34, 33, 35, 34])));
  assert.equal(dry.level, "dry");
  const ok = weatherAdvice(parseOpenMeteo(openMeteo([50, 30, 60, 20, 45])));
  assert.equal(ok.level, "ok");
  assert.equal(ok.text, "Good days to spray or apply fertilizer: Wed, Fri.");
});

test("refresh stores all 15 counties; a failing county keeps its old forecast", async () => {
  assert.equal((await refreshWeather(ctx.db, { fetch: fakeFetch(openMeteo()), now: clock })).updated, 15);
  let n = 0;
  const flaky = async () => { if (n++ === 1) throw new Error("timeout"); return { ok: true, json: async () => openMeteo([10, 10, 10, 10, 10]) }; };
  const r = await refreshWeather(ctx.db, { fetch: flaky, now: clock });
  assert.equal(r.updated, 14);
  assert.match(r.failed[0], /^Bong: timeout/); // second county in the list
  assert.equal(getForecast(ctx.db, "Bong", clock).days[0].rain_prob, 80, "old forecast kept");
  assert.equal(getForecast(ctx.db, "Bomi", clock).days[0].rain_prob, 10);
});

test("old days are dropped from a stored forecast", async () => {
  await refreshWeather(ctx.db, { fetch: fakeFetch(openMeteo()), now: clock });
  clock = new Date(clock.getTime() + 2 * DAY);
  assert.equal(getForecast(ctx.db, "Bong", clock).days[0].date, "2026-06-04");
});

test("rain alerts go to the county's farmers (not STOP), at most once in 3 days", async () => {
  await refreshWeather(ctx.db, { fetch: fakeFetch(openMeteo()), now: clock });
  farmer("0777000001", "Bong");
  const stopped = farmer("0777000002", "Bong");
  setOptedOut(ctx.db, stopped.id, true);
  const sent = sendWeatherAlerts(ctx);
  assert.equal(sent.length, 15);
  assert.equal(sent.find((a) => a.county === "Bong").reach, 1);
  const [msg] = listMessages(ctx.db, { phone: "+231777000001" });
  assert.equal(msg.kind, "weather");
  assert.match(msg.body, /^WEATHER Bong: Heavy rain/);
  assert.ok(msg.body.length <= 160);
  assert.equal(sendWeatherAlerts(ctx).length, 0, "not again the same day");
  clock = new Date(clock.getTime() + 3 * DAY + 1000);
  await refreshWeather(ctx.db, { fetch: fakeFetch({ daily: { ...openMeteo().daily, time: ["2026-06-05", "2026-06-06", "2026-06-07", "2026-06-08", "2026-06-09"] } }), now: clock });
  assert.equal(sendWeatherAlerts(ctx).length, 15, "allowed again after 3 days");
});

test("USSD weather screen fits and can be sent by SMS; SMS WEATHER replies with advice", async () => {
  await refreshWeather(ctx.db, { fetch: fakeFetch(openMeteo()), now: clock });
  for (const county of Object.keys(COUNTY_POINTS)) farmer(`07770001${String(Object.keys(COUNTY_POINTS).indexOf(county)).padStart(2, "0")}`, county);
  for (let i = 0; i < 15; i++) {
    const r = handleUssd(ctx, { phoneNumber: `07770001${String(i).padStart(2, "0")}`, text: "2" });
    assert.ok(r.text.length <= USSD_MAX, `${r.text.length}: ${r.text}`);
    assert.match(r.text, /Tue 29C rain 80%/);
  }
  assert.equal(handleUssd(ctx, { phoneNumber: "0777000100", text: "2*1" }).text, "Sent! Check your SMS.");
  const reply = handleInboundSms(ctx, { from: "0777000100", text: "weather" }).reply;
  assert.match(reply, /^Bomi: Heavy rain/);
});

test("no forecast yet: a polite message", () => {
  farmer("0777000001");
  assert.match(handleUssd(ctx, { phoneNumber: "0777000001", text: "2" }).text, /No forecast for Bong yet/);
});

// ---------------------------------------------------------------- prices
test("prices: recorded, latest shown with the weekly change", () => {
  clock = new Date(clock.getTime() - 10 * DAY);
  recordPrice(ctx, { market: "GBARNGA", item: "RICE", price: 40 });
  recordPrice(ctx, { market: "gbarnga", item: "rice", price: 40 });
  clock = new Date(clock.getTime() + 10 * DAY);
  recordPrice(ctx, { market: "GBARNGA", item: "RICE", price: 45 });
  const list = latestPrices(ctx, "GBARNGA");
  assert.equal(list.market_name, "Gbarnga");
  assert.deepEqual(list.items.map((i) => [i.code, i.price_lrd, i.change_pct]), [["RICE", 45, 13]]);
});

test("a price far from recent prices is flagged and hidden until an officer approves it", () => {
  recordPrice(ctx, { market: "GANTA", item: "PEPPER", price: 75 });
  recordPrice(ctx, { market: "GANTA", item: "PEPPER", price: 80 });
  const typo = recordPrice(ctx, { market: "GANTA", item: "PEPPER", price: 750 });
  assert.equal(typo.status, "flagged");
  assert.equal(latestPrices(ctx, "GANTA").items[0].price_lrd, 80);
});

test("bad prices are refused with a clear reason", () => {
  assert.throws(() => recordPrice(ctx, { market: "PARIS", item: "RICE", price: 45 }), /unknown market/);
  assert.throws(() => recordPrice(ctx, { market: "GANTA", item: "GOLD", price: 45 }), /unknown item/);
  assert.throws(() => recordPrice(ctx, { market: "GANTA", item: "RICE", price: -3 }), /price/);
});

test("SMS: reporters send PRICE; others cannot; anyone can ask PRICES", () => {
  addReporter(ctx, { phone: "0886000001", name: "Comfort", market: "GBARNGA" });
  assert.match(handleInboundSms(ctx, { from: "0886000001", text: "PRICE GBARNGA RICE 45" }).reply, /Saved: Local rice 45 LRD\/cup at Gbarnga/);
  assert.match(handleInboundSms(ctx, { from: "0886000001", text: "price gbarnga pepper 75lrd" }).reply, /Hot pepper 75 LRD/);
  assert.match(handleInboundSms(ctx, { from: "0886000001", text: "PRICE GBARNGA GOLD 9" }).reply, /^Not saved\. item: unknown item/);
  assert.match(handleInboundSms(ctx, { from: "0777999999", text: "PRICE GBARNGA RICE 5" }).reply, /Only registered market reporters/);
  const ask = handleInboundSms(ctx, { from: "0777999999", text: "PRICES GBARNGA" }).reply;
  assert.equal(ask, "GBARNGA (LRD):\nRICE 45/cup\nPEPPER 75/pile");
});

test("USSD prices: the farmer's own county market is listed first; screens fit", () => {
  addReporter(ctx, { phone: "0886000001", market: "GANTA" });
  for (const it of content.items) recordPrice(ctx, { market: "GANTA", item: it.code, price: 1234.5 });
  farmer("0777000001", "Nimba");
  assert.match(handleUssd(ctx, { phoneNumber: "0777000001", text: "3" }).text, /^Which market\?\n1 Ganta/);
  const r = handleUssd(ctx, { phoneNumber: "0777000001", text: "3*1" });
  assert.ok(r.text.length <= USSD_MAX, r.text);
  assert.match(r.text, /1 Get by SMS$/);
  assert.equal(handleUssd(ctx, { phoneNumber: "0777000001", text: "3*1*1" }).text, "Sent! Check your SMS.");
  assert.ok(listMessages(ctx.db, { phone: "+231777000001" })[0].body.length <= 160);
  assert.match(handleUssd(ctx, { phoneNumber: "0777000001", text: "3*2" }).text, /no prices this week yet/);
});

test("priceText never goes over the limit", () => {
  const list = { market_name: "Red Light (Monrovia)", items: content.items.map((i) => ({ code: i.code, unit: i.unit, price_lrd: 123456 })) };
  assert.ok(priceText(list).length <= 160);
});

// ---------------------------------------------------------------- HTTP
test("over HTTP: public weather & prices, officer price tools, weather refresh, farmer home", async () => {
  const api = await startTestServer({ now: () => new Date("2026-06-02T08:00:00Z") });
  try {
    assert.equal((await api.call("GET", "/api/weather?county=Bong")).body.days.length, 0);
    assert.equal((await api.call("POST", "/api/reporters", { phone: "0886000001", market: "GBARNGA" })).status, 201);
    assert.equal((await api.call("POST", "/api/prices", { market: "GBARNGA", item: "RICE", price: 45 })).status, 201);
    await api.call("POST", "/api/prices", { market: "GBARNGA", item: "RICE", price: 46 });
    const flagged = (await api.call("POST", "/api/prices", { market: "GBARNGA", item: "RICE", price: 460 })).body;
    assert.equal(flagged.status, "flagged");
    assert.equal((await api.call("GET", "/api/prices/flagged")).body.length, 1);
    await api.call("PATCH", `/api/prices/${flagged.id}`, { status: "rejected" });
    assert.equal((await api.call("GET", "/api/prices/flagged")).body.length, 0);
    const prices = (await api.call("GET", "/api/prices?market=GBARNGA")).body;
    assert.equal(prices.items[0].price_lrd, 46);
    assert.equal((await api.call("GET", "/api/prices")).body.length, 6);
    assert.equal((await api.call("GET", "/api/markets")).body.items.length, 8);
  } finally {
    await api.close();
  }
});

test("officer can refresh the weather now (uses the configured source)", async () => {
  const { createApp } = await import("../src/app.js");
  const db = openDb(":memory:");
  const app = createApp({ db, content, now: () => clock, officerToken: "", webhookSecret: "", weatherFetch: fakeFetch(openMeteo()) });
  const server = await new Promise((ok) => { const s = app.listen(0, () => ok(s)); });
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const r = await (await fetch(base + "/api/jobs/weather/run", { method: "POST" })).json();
    assert.equal(r.updated, 15);
    const bong = await (await fetch(base + "/api/weather?county=bong")).json();
    assert.equal(bong.advice.level, "rain");
    assert.equal((await (await fetch(base + "/api/weather")).json()).length, 15);
  } finally {
    await new Promise((ok) => server.close(ok));
  }
});
