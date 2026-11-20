// Weather: a 5-day forecast for each county, turned into farm advice.
//
// Source: Open-Meteo (https://open-meteo.com), free, no key needed, covers all of Liberia.
// Forecasts are fetched for each county capital every few hours and stored, so farmers
// still get the last forecast if the internet link to the server drops.
// Liberia uses GMT all year, so forecast dates are local dates.
import { sendSms } from "./messaging.js";

export const OPEN_METEO_URL = "https://api.open-meteo.com/v1/forecast";

// County capitals (approximate coordinates; good enough for a county-level forecast).
export const COUNTY_POINTS = {
  "Bomi": [6.87, -10.82], "Bong": [7.00, -9.47], "Gbarpolu": [7.07, -10.49],
  "Grand Bassa": [5.88, -10.05], "Grand Cape Mount": [6.75, -11.37], "Grand Gedeh": [6.07, -8.13],
  "Grand Kru": [4.68, -8.23], "Lofa": [8.42, -9.75], "Margibi": [6.53, -10.35],
  "Maryland": [4.38, -7.72], "Montserrado": [6.30, -10.80], "Nimba": [7.36, -8.71],
  "River Cess": [5.46, -9.58], "River Gee": [5.20, -7.87], "Sinoe": [5.01, -9.04]
};

// Rules (draft: check with MOA / CARI and adjust).
export const HEAVY_RAIN_PROB = 70;   // % chance of rain
export const HEAVY_RAIN_MM = 20;     // mm in a day
export const GOOD_DAY_PROB = 40;     // below this, a good day to spray or apply fertilizer
export const ALERT_EVERY_DAYS = 3;   // at most one weather alert per county in this many days

const DAY_NAMES = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
export const dayName = (date) => DAY_NAMES[new Date(date + "T12:00:00Z").getUTCDay()];

/** Turn an Open-Meteo answer into our day list. */
export function parseOpenMeteo(json) {
  const d = json?.daily;
  if (!d?.time?.length) throw new Error("Open-Meteo answer has no daily forecast");
  return d.time.map((date, i) => ({
    date,
    rain_prob: Math.round(d.precipitation_probability_max?.[i] ?? 0),
    rain_mm: Math.round((d.precipitation_sum?.[i] ?? 0) * 10) / 10,
    t_max: Math.round(d.temperature_2m_max?.[i] ?? 0),
    t_min: Math.round(d.temperature_2m_min?.[i] ?? 0),
    code: d.weather_code?.[i] ?? null
  }));
}

export async function fetchCountyForecast(county, { fetch = globalThis.fetch, url = OPEN_METEO_URL } = {}) {
  const [lat, lon] = COUNTY_POINTS[county];
  const q = new URLSearchParams({
    latitude: lat, longitude: lon, timezone: "GMT", forecast_days: "5",
    daily: "weather_code,temperature_2m_max,temperature_2m_min,precipitation_sum,precipitation_probability_max"
  });
  const res = await fetch(`${url}?${q}`, { signal: AbortSignal.timeout(15000) });
  if (!res.ok) throw new Error(`Open-Meteo HTTP ${res.status}`);
  return parseOpenMeteo(await res.json());
}

/** Fetch all 15 counties and store them. Counties that fail keep their previous forecast. */
export async function refreshWeather(db, { fetch, url, now = new Date() } = {}) {
  const result = { updated: 0, failed: [] };
  for (const county of Object.keys(COUNTY_POINTS)) {
    try {
      const days = await fetchCountyForecast(county, { fetch, url });
      db.prepare("INSERT INTO weather_forecasts (county, days, fetched_at) VALUES (?, ?, ?) ON CONFLICT(county) DO UPDATE SET days = excluded.days, fetched_at = excluded.fetched_at")
        .run(county, JSON.stringify(days), now.toISOString());
      result.updated++;
    } catch (err) {
      result.failed.push(`${county}: ${err.message}`);
    }
  }
  return result;
}

/** The stored forecast for a county, from today on. Null if we have none. */
export function getForecast(db, county, now = new Date()) {
  const row = db.prepare("SELECT * FROM weather_forecasts WHERE county = ?").get(county);
  if (!row) return null;
  const today = now.toISOString().slice(0, 10);
  const days = JSON.parse(row.days).filter((d) => d.date >= today);
  // fetched_at "sample" = demo data from npm run seed (shown as such), replaced by the first real refresh.
  return days.length ? { county, fetched_at: row.fetched_at, sample: row.fetched_at === "sample", days, advice: weatherAdvice(days) } : null;
}

const isHeavy = (d) => d.rain_prob >= HEAVY_RAIN_PROB || d.rain_mm >= HEAVY_RAIN_MM;

/**
 * Farm advice from the forecast. Returns { level: "rain" | "dry" | "ok", heavy_rain_soon, text }.
 * text is short enough for one SMS together with a county name.
 */
export function weatherAdvice(days) {
  const next2 = days.slice(0, 2);
  const heavy = next2.filter(isHeavy);
  if (heavy.length) {
    const firstGood = days.find((d) => !isHeavy(d) && d.rain_prob < GOOD_DAY_PROB && !next2.includes(d));
    const wait = firstGood ? `Wait until ${dayName(firstGood.date)}.` : "Wait for a dry day.";
    return {
      level: "rain",
      heavy_rain_soon: true,
      text: `Heavy rain ${heavy.map((d) => dayName(d.date)).join(" & ")}. Don't spray or apply fertilizer: rain will wash it off. ${wait} Clear drainage.`
    };
  }
  if (days.length >= 4 && days.every((d) => d.rain_prob < 20) && days.some((d) => d.t_max >= 33)) {
    return { level: "dry", heavy_rain_soon: false, text: "Hot and dry days ahead. Water seedlings early morning or evening. Mulch to keep the soil wet." };
  }
  const good = days.filter((d) => d.rain_prob < GOOD_DAY_PROB).map((d) => dayName(d.date));
  return {
    level: "ok",
    heavy_rain_soon: false,
    text: good.length ? `Good days to spray or apply fertilizer: ${good.slice(0, 3).join(", ")}.` : "Showers most days. Spray only on a dry morning."
  };
}

/** A 3-line forecast for USSD / SMS, e.g. "Tue 29C rain 80%". */
export function shortForecast(days, n = 3) {
  return days.slice(0, n).map((d) => `${dayName(d.date)} ${d.t_max}C rain ${d.rain_prob}%`).join("\n");
}

/**
 * Rain alerts: for each county with heavy rain in the next 2 days, SMS every farmer there
 * (not STOP) — at most once every ALERT_EVERY_DAYS days per county.
 */
export function sendWeatherAlerts(ctx) {
  const { db } = ctx;
  const now = ctx.now();
  const sent = [];
  for (const county of Object.keys(COUNTY_POINTS)) {
    const f = getForecast(db, county, now);
    if (!f?.advice.heavy_rain_soon) continue;
    const recent = db.prepare("SELECT 1 FROM weather_alerts WHERE county = ? AND sent_at >= ?")
      .get(county, new Date(now.getTime() - ALERT_EVERY_DAYS * 24 * 3600 * 1000).toISOString());
    if (recent) continue;
    const message = `WEATHER ${county}: ${f.advice.text}`.slice(0, 160);
    let reach = 0;
    for (const farmer of db.prepare("SELECT id, phone FROM farmers WHERE county = ? AND opted_out_at IS NULL").all(county)) {
      if (!sendSms(db, { phone: farmer.phone, farmerId: farmer.id, body: message, kind: "weather" }).skipped) reach++;
    }
    db.prepare("INSERT INTO weather_alerts (county, message, reach, sent_at) VALUES (?, ?, ?, ?)").run(county, message, reach, now.toISOString());
    sent.push({ county, reach, message });
  }
  return sent;
}
