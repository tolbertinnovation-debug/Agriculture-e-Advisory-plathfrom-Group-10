// AgriConnect farmer app: offline-first.
//
// - Sign in with phone number + SMS code (no password).
// - Everything the farmer sees is cached on the phone, so the app works with no network.
// - Pest reports and questions made offline go into an "outbox" and are sent when the
//   signal returns. Each has a client_id, so sending twice never creates duplicates.
// - Pest Doctor runs the SAME engine as the server (engine.js), so it works offline.
import { diagnose } from "./engine.js";

const API = new URLSearchParams(location.search).get("api") || location.origin;
const $ = (s) => document.querySelector(s);
const esc = (v) => String(v ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const COUNTIES = ["Bomi", "Bong", "Gbarpolu", "Grand Bassa", "Grand Cape Mount", "Grand Gedeh", "Grand Kru", "Lofa", "Margibi", "Maryland", "Montserrado", "Nimba", "River Cess", "River Gee", "Sinoe"];
const LANGUAGES = [["en", "Liberian English"], ["kpe", "Kpelle"], ["bsq", "Bassa"], ["kss", "Kissi"]];

// ---------------------------------------------------------------- storage (never crashes)
const store = {
  get(key, fallback = null) { try { const v = localStorage.getItem("ac:" + key); return v == null ? fallback : JSON.parse(v); } catch { return fallback; } },
  set(key, value) { try { localStorage.setItem("ac:" + key, JSON.stringify(value)); } catch {} },
  clear() { try { Object.keys(localStorage).filter((k) => k.startsWith("ac:")).forEach((k) => localStorage.removeItem(k)); } catch {} }
};

const state = {
  token: store.get("token"),
  phone: store.get("phone"),
  home: store.get("home"),          // last /api/me/home answer
  content: store.get("content"),    // crops + pests, for offline use
  outbox: store.get("outbox", []),  // things waiting to be sent
  screen: "home",
  pendingPhone: null,
  devCode: null,
  lastResult: null,                 // last Pest Doctor result
  prices: store.get("prices", {}),  // market id -> last price list (offline copy)
  market: store.get("market"),      // market chosen on the Prices screen
  error: null,
  notice: null,                     // a short "done" message on the current screen
  photo: null,                      // photo picked for the next question (a small JPEG data URL)
  busy: false
};
const save = () => { store.set("home", state.home); store.set("content", state.content); store.set("outbox", state.outbox); store.set("prices", state.prices); store.set("market", state.market); };

// Icons come from assets/icons.js (Lucide). ic("sprout") → an inline SVG.
const ic = (name, cls = "i") => `<svg class="${cls}" aria-hidden="true"><use href="#i-${name}"/></svg>`;
const WEATHER_ICON = { rain: "cloud-rain", dry: "sun", ok: "cloud-sun" };
const dayName = (date) => ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"][new Date(date + "T12:00:00Z").getUTCDay()];

async function loadPrices(market) {
  try { state.prices[market] = await api("GET", "/api/prices?market=" + encodeURIComponent(market)); save(); } catch {}
}

// ---------------------------------------------------------------- network
async function api(method, path, body) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 10000); // rural networks: don't hang forever
  try {
    const res = await fetch(API + path, {
      method,
      signal: ctrl.signal,
      headers: { ...(body ? { "Content-Type": "application/json" } : {}), ...(state.token ? { Authorization: "Bearer " + state.token } : {}) },
      body: body ? JSON.stringify(body) : undefined
    });
    const data = await res.json().catch(() => ({}));
    if (res.status === 401 && state.token) { signOut(false); throw Object.assign(new Error("Please sign in again"), { status: 401 }); }
    if (!res.ok) throw Object.assign(new Error(data.details ? data.details.join("; ") : data.error || "Something went wrong"), { status: res.status });
    return data;
  } catch (err) {
    if (err.name === "AbortError" || err instanceof TypeError) throw Object.assign(new Error("No network. Try again when you have signal."), { offline: true });
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

const online = () => navigator.onLine !== false;
const newId = () => (crypto.randomUUID ? crypto.randomUUID() : String(Date.now()) + Math.random().toString(16).slice(2)).replace(/[^A-Za-z0-9-]/g, "");

async function loadContent() {
  try {
    const [crops, pests, markets] = await Promise.all([api("GET", "/api/content/crops"), api("GET", "/api/content/pests"), api("GET", "/api/markets")]);
    state.content = { crops, ...pests, markets: markets.markets };
    save();
  } catch {}
}

async function refreshHome() {
  if (!state.token) return;
  try {
    state.home = await api("GET", "/api/me/home");
    if (state.home.prices) { state.prices[state.home.prices.market] = state.home.prices; if (!state.market) state.market = state.home.prices.market; }
    save();
  } catch (err) {
    if (err.status === 403) { state.home = null; state.screen = "register"; }
  }
}

/** Send everything in the outbox. Stops at the first network problem and tries again later. */
let syncing = false;
async function sync() {
  if (syncing || !state.token || !state.outbox.length || !online()) return;
  syncing = true;
  try {
    while (state.outbox.length) {
      const item = state.outbox[0];
      try {
        await api("POST", item.type === "report" ? "/api/me/reports" : "/api/me/questions", item.payload);
      } catch (err) {
        if (err.offline || err.status >= 500 || err.status === 429 || err.status === 401) break; // try again later
        item.error = err.message; // a real problem with this item: keep it out of the way
      }
      state.outbox.shift();
      save();
    }
    await refreshHome();
  } finally {
    syncing = false;
    render();
  }
}

// ---------------------------------------------------------------- photos
/**
 * Make a phone photo small enough to send over a weak signal and keep offline:
 * at most 1024 px on the long side, JPEG quality 0.7 (about 60-200 KB).
 */
async function shrinkPhoto(file, maxSide = 1024, quality = 0.7) {
  const url = URL.createObjectURL(file);
  try {
    const img = await new Promise((ok, fail) => { const i = new Image(); i.onload = () => ok(i); i.onerror = () => fail(new Error("This file is not a picture.")); i.src = url; });
    const scale = Math.min(1, maxSide / Math.max(img.naturalWidth, img.naturalHeight));
    const canvas = Object.assign(document.createElement("canvas"), { width: Math.round(img.naturalWidth * scale), height: Math.round(img.naturalHeight * scale) });
    canvas.getContext("2d").drawImage(img, 0, 0, canvas.width, canvas.height);
    let data = canvas.toDataURL("image/jpeg", quality);
    if (data.length > 700000) data = canvas.toDataURL("image/jpeg", 0.5); // very detailed photo: squeeze harder
    return data;
  } finally {
    URL.revokeObjectURL(url);
  }
}

// ---------------------------------------------------------------- shell
function appbar(title, back) {
  const waiting = state.outbox.length;
  const badge = !online()
    ? `<span class="pill offline">● Offline${waiting ? ` · ${waiting} waiting` : ""}</span>`
    : waiting ? `<span class="pill waiting">⟳ Sending ${waiting}…</span>` : `<span class="pill online"><i class="dot"></i>Offline ready</span>`;
  const me = state.token && state.screen === "home" ? `<button class="back" data-go="profile" aria-label="My profile">${ic("user")}</button>` : "";
  $("#appbar").innerHTML =
    (back ? `<button class="back" data-go="home" aria-label="Back">${ic("arrow-left")}</button>` : `<span class="mark">${ic("sprout")}</span>`) +
    `<h1>${esc(title)}</h1>${state.token ? badge : ""}${me}`;
}

function tabbar() {
  const tabs = [["home", "house", "Home"], ["guide", "calendar-days", "Crops"], ["pest", "scan-search", "Pest Doctor"], ["prices", "coins", "Prices"], ["ask", "messages-square", "Ask"]];
  $("#footer").innerHTML = `<nav class="tabbar">` + tabs.map(([id, icon, l]) =>
    `<button class="${state.screen === id ? "on" : ""}" data-go="${id}" aria-label="${l}">${ic(icon)}<span>${l}</span></button>`).join("") + `</nav>`;
}

const errBox = () => (state.error ? `<div class="err">${esc(state.error)}</div>` : "");
const cropName = (id) => state.content?.crops?.find((c) => c.id === id)?.name ?? state.content?.report_crops?.find((c) => c.id === id)?.label ?? id;
const when = (sql) => (sql ? new Date(sql.replace(" ", "T") + (sql.endsWith("Z") ? "" : "Z")).toLocaleDateString("en-GB", { day: "numeric", month: "short" }) : "");

// ---------------------------------------------------------------- screens
const screens = {
  login() {
    appbar("AgriConnect", false);
    const steps = `<div class="steps"><span class="${state.pendingPhone ? "done" : "on"}">1 Phone</span><span class="${state.pendingPhone ? "on" : ""}">2 Code</span><span>3 Your farm</span></div>`;
    if (!state.pendingPhone) {
      return `
        <div class="hero-mark">${ic("sprout")}</div>
        <h2 class="center" style="margin:0">Welcome to AgriConnect</h2>
        <p class="center muted" style="margin:0">Free farm advice, pest help, weather and market prices for Liberian farmers.</p>
        ${errBox()}
        <form data-form="phone" class="card" style="display:flex;flex-direction:column;gap:12px">
          <h3 style="margin:0">Log in or sign up</h3>
          <label class="field">Your phone number<input type="tel" name="phone" placeholder="0777 123 456" autocomplete="tel" required></label>
          <button class="btn" ${state.busy ? "disabled" : ""}>${state.busy ? "Sending…" : `Continue ${ic("arrow-right")}`}</button>
          <small class="muted">New here? Use the same button: we will set up your free account. No password needed.</small>
        </form>
        ${steps}
        <p class="center muted" style="margin:0">No smartphone? Dial <b>*347#</b> on any phone.</p>
        <p class="center muted" style="margin:0"><a href="/prototype/dashboard.html">Extension officer or staff? Log in here</a></p>`;
    }
    return `
      <h2 style="margin:0">Enter your code</h2>
      <p class="muted" style="margin:0">We sent a free SMS to <b>${esc(state.pendingPhone)}</b>.</p>
      ${state.devCode ? `<div class="note">Demo: no real SMS is sent, so your code is filled in for you.</div>` : ""}
      ${errBox()}
      <form data-form="code" class="card" style="display:flex;flex-direction:column;gap:12px">
        <label class="field">6-digit code<input inputmode="numeric" name="code" maxlength="6" pattern="\\d{6}" autocomplete="one-time-code" value="${esc(state.devCode ?? "")}" data-action="code-input" required></label>
        <button class="btn" ${state.busy ? "disabled" : ""}>${state.busy ? "Checking…" : `Continue ${ic("arrow-right")}`}</button>
      </form>
      ${steps}
      <button class="linkish" data-action="change-phone">Use another number</button>`;
  },

  register() {
    appbar("Create your account", false);
    const crops = state.content?.crops ?? [];
    return `
      <div class="steps"><span class="done">1 Phone</span><span class="done">2 Code</span><span class="on">3 Your farm</span></div>
      <h2 style="margin:0">Tell us about your farm</h2>
      <p class="muted" style="margin:0">Last step. So we can send the right advice at the right time.</p>
      ${errBox()}
      <form data-form="register" class="card" style="display:flex;flex-direction:column;gap:12px">
        <label class="field">Your name <small>(optional)</small><input type="text" name="name" maxlength="80"></label>
        <label class="field">County<select name="county" required><option value="">Choose…</option>${COUNTIES.map((c) => `<option>${c}</option>`).join("")}</select></label>
        <label class="field">District or town <small>(optional)</small><input type="text" name="district" maxlength="80"></label>
        <label class="field">Language<select name="language">${LANGUAGES.map(([v, l]) => `<option value="${v}">${l}</option>`).join("")}</select></label>
        <div class="field">Your crops and the month you plant them
          ${crops.length ? crops.map((c) => `<div class="crop-row"><label class="check"><input type="checkbox" name="crop" value="${esc(c.id)}"> ${esc(c.name)}</label>
            <select name="month-${esc(c.id)}" aria-label="Planting month for ${esc(c.name)}">${MONTHS.map((m, i) => `<option value="${i + 1}" ${i === 4 ? "selected" : ""}>${m}</option>`).join("")}</select></div>`).join("")
            : `<small>Connect to the internet once to load the crop list.</small>`}
        </div>
        <label class="check"><input type="checkbox" name="consent" required> I agree to get free farm advice by SMS. My number stays private. I can reply STOP anytime.</label>
        <button class="btn" ${state.busy ? "disabled" : ""}>${state.busy ? "Saving…" : "Create my account"}</button>
      </form>`;
  },

  home() {
    appbar("AgriConnect", false);
    const h = state.home;
    if (!h) return `<p class="muted">Connect to the internet once to load your farm advice.</p>${errBox()}`;
    const f = h.farmer;
    const hour = new Date().getHours();
    const greet = hour < 12 ? "Good morning" : hour < 17 ? "Good afternoon" : "Good evening";
    const alerts = [
      ...h.alerts.hotspots.map((x) => `<div class="card alert"><b>${ic("triangle-alert")} Pest alert · ${esc(x.county)} County</b><p>${esc(x.pest_name)}: ${x.reports} farmers reported it this week. Check your fields.</p></div>`),
      ...h.alerts.broadcasts.slice(0, 2).map((b) => `<div class="card alert"><b>${ic("megaphone")} Officer advisory · ${esc(when(b.created_at))}</b><p>${esc(b.message)}</p></div>`)
    ].join("");
    const done = store.get("done:" + h.date, {});
    const tasks = h.advice.map((a, i) => a.message
      ? `<label class="task"><input type="checkbox" data-action="task" data-key="${esc(a.crop)}-${i}" ${done[a.crop + "-" + i] ? "checked" : ""}><span><span class="tag">${esc(cropName(a.crop))}</span> ${esc(a.message.replace(/^[A-Z][A-Z ()]+:\s*/, ""))}</span></label>`
      : `<div class="task"><span class="tag">${esc(cropName(a.crop))}</span><span class="muted">Between seasons. Advice starts when your season starts.</span></div>`).join("");
    const today = h.weather?.days?.[0];
    return `
      <div><div class="muted">${esc(f.district ? f.district + ", " : "")}${esc(f.county)} County</div><p class="hello">${greet}${f.name ? ", " + esc(f.name) : ""}</p></div>
      ${h.weather ? `<button class="card weather-hero" data-go="weather" style="text-align:left;font:inherit">
        <span class="big">${ic(WEATHER_ICON[h.weather.advice.level], "i wx")}</span>
        <div style="flex:1"><div class="temp">${today.t_max}°C</div>
        <div style="font-size:13.5px">${esc(h.weather.advice.text)} · ${today.rain_prob}% rain</div></div><span class="hero-more">5-day ${ic("chevron-right")}</span></button>` : ""}
      ${alerts}
      <div class="grid">
        <button class="tile" data-go="guide"><span class="ic green">${ic("calendar-days")}</span>Crop Guide</button>
        <button class="tile" data-go="pest"><span class="ic red">${ic("scan-search")}</span>Pest Doctor</button>
        <button class="tile" data-go="prices"><span class="ic gold">${ic("coins")}</span>Market Prices</button>
        <button class="tile" data-go="ask"><span class="ic gold">${ic("messages-square")}</span>Ask Expert</button>
        <button class="tile" data-go="weather"><span class="ic blue">${ic("cloud-sun")}</span>Weather</button>
        <button class="tile" data-go="reports"><span class="ic green">${ic("clipboard-list")}</span>My Reports</button>
      </div>
      <div class="card"><h3>This week on your farm</h3>${tasks || `<p class="muted" style="margin:0">No tasks this week.</p>`}</div>
      <p class="muted center" style="margin:0">Updated ${esc(h.date)}</p>`;
  },

  guide() {
    appbar("Crop Guide", true);
    const h = state.home;
    if (!h || !state.content) return `<p class="muted">Connect once to load your crop calendar.</p>`;
    return h.farmer.crops.map((fc) => {
      const crop = state.content.crops.find((c) => c.id === fc.crop);
      if (!crop) return "";
      const now = h.advice.find((a) => a.crop === fc.crop)?.stage;
      return `<div class="card"><div class="eyebrow">Planted in ${MONTHS[fc.planting_month - 1]}</div><h3 style="margin-top:4px">${esc(crop.name)}</h3>
        <div class="timeline">${crop.stages.map((s) => `<div class="step ${s.id === now ? "now" : ""}">
          <div class="when">${s.from_week < 0 ? `${-s.from_week}–${Math.max(1, -s.to_week)} weeks before planting` : `Weeks ${s.from_week}–${s.to_week}`}${s.id === now ? " · NOW" : ""}</div>
          <div class="t">${esc(s.name)}</div><p>${esc(s.sms.en)}</p></div>`).join("")}</div></div>`;
    }).join("") + (state.content.crops[0]?.status === "draft" ? `<p class="muted center">Advice is a draft until reviewed by an agronomist.</p>` : "");
  },

  pest() {
    appbar("Pest Doctor", true);
    const c = state.content;
    if (!c) return `<p class="muted">Connect once to load Pest Doctor. After that it works offline.</p>`;
    const r = state.lastResult;
    return `
      ${errBox()}
      <form data-form="pest" class="card">
        <h3>What do you see?</h3>
        ${Object.entries(c.symptoms).map(([code, label]) => `<label class="check"><input type="checkbox" name="symptom" value="${esc(code)}"> ${esc(label)}</label>`).join("")}
        <label class="field" style="margin-top:10px">Which crop?<select name="crop">${c.report_crops.map((x) => `<option value="${esc(x.id)}">${esc(x.label)}</option>`).join("")}</select></label>
        <button class="btn" style="margin-top:12px">Check my plant</button>
      </form>
      ${r ? r.pest ? `
        <div class="card result">
          <span class="match">${r.score}% match</span>
          <h3 style="margin-top:6px">${esc(r.pest.name)}</h3>
          <p style="margin:6px 0 0;font-size:14.5px">${esc(r.pest.sms.en.replace(/ Officer told\.$/, ""))}</p>
          <p class="muted" style="margin:10px 0 0">${r.queued ? `${ic("clock")} Saved. It goes to your extension officer as soon as you have network.` : `${ic("circle-check")} Sent to your extension officer.`}</p>
        </div>` : `<div class="card">We could not match these signs. Your report ${r.queued ? "will go" : "went"} to an extension officer, who will call you.</div>` : ""}`;
  },

  weather() {
    appbar(`Weather · ${state.home?.farmer.county ?? ""}`, true);
    const w = state.home?.weather;
    if (!w) return `<p class="muted">No forecast yet. Connect to the internet and try again.</p>`;
    return `
      <div class="card ${w.advice.level === "rain" ? "alert" : ""}" style="${w.advice.level === "rain" ? "" : "background:var(--leaf-soft);border-color:#C5DDBF"}">
        <b>${ic(WEATHER_ICON[w.advice.level])} Farm advice</b><p style="margin:4px 0 0;font-size:15px">${esc(w.advice.text)}</p></div>
      <div class="card"><h3>Next ${w.days.length} days · chance of rain</h3>
        ${w.days.map((d, i) => `<div class="day"><span class="d">${i === 0 ? "Today" : dayName(d.date)}</span><span class="muted" style="width:62px">${d.t_max}° / ${d.t_min}°</span>
          <div class="rainbar"><i style="width:${d.rain_prob}%"></i></div><b style="width:44px;text-align:right">${d.rain_prob}%</b></div>`).join("")}
      </div>
      <p class="muted center" style="margin:0">${w.sample ? "Sample forecast (demo data)" : `Forecast: Open-Meteo · updated ${esc(when(w.fetched_at))}`}</p>`;
  },

  prices() {
    appbar("Market Prices", true);
    const markets = state.content?.markets ?? [];
    const id = state.market ?? markets[0]?.id;
    const list = state.prices[id];
    const change = (c) => c == null ? `<span class="flat">new</span>` : c > 0 ? `<span class="up">▲ ${c}%</span>` : c < 0 ? `<span class="down">▼ ${-c}%</span>` : `<span class="flat">— 0%</span>`;
    return `
      <label class="field">Market<select data-action="market">${markets.map((m) => `<option value="${esc(m.id)}" ${m.id === id ? "selected" : ""}>${esc(m.name)}</option>`).join("")}</select></label>
      <div class="card">
        <h3>Prices this week (LRD)</h3>
        ${!list ? `<p class="muted">Connect to the internet to load prices for this market.</p>`
          : !list.items.length ? `<p class="muted">No prices reported at ${esc(list.market_name)} this week yet.</p>`
          : `<table><tr><th>Item</th><th style="text-align:right">Price</th><th style="text-align:right">vs last week</th></tr>
            ${list.items.map((it) => `<tr><td>${esc(it.name)}<div class="muted">per ${esc(it.unit)}</div></td><td class="num">${Number(it.price_lrd).toLocaleString("en-US")}</td><td style="text-align:right">${change(it.change_pct)}</td></tr>`).join("")}</table>`}
      </div>
      <p class="muted center" style="margin:0">Reported by market reporters. SMS <b>PRICES GBARNGA</b> or dial *347# option 3 on any phone.</p>`;
  },

  reports() {
    appbar("My Reports", true);
    const waiting = state.outbox.filter((o) => o.type === "report");
    const sent = state.home?.reports ?? [];
    const names = Object.fromEntries((state.content?.pests ?? []).map((p) => [p.id, p.name]));
    const row = (title, sub, status, label) => `<div class="list-item"><div><b>${esc(title)}</b><div class="muted">${esc(sub)}</div></div><span class="status st-${status}">${esc(label)}</span></div>`;
    const items = [
      ...waiting.map((o) => row(cropName(o.payload.crop), "Saved on this phone", "waiting", "Waiting to send")),
      ...sent.map((r) => row(`${cropName(r.crop)}: ${names[r.confirmed_pest ?? r.suggested_pest] ?? "Not matched"}`, `PR-${r.id} · ${when(r.created_at)}`, r.status,
        r.status === "verified" ? "Officer confirmed" : r.status === "new" ? "With officer" : r.status))
    ];
    return `<div class="card">${items.length ? items.join("") : `<p class="muted">No reports yet. Use Pest Doctor when you see a problem.</p>`}</div>`;
  },

  ask() {
    appbar("Ask an Expert", true);
    const waiting = state.outbox.filter((o) => o.type === "question")
      .map((o) => ({ body: o.payload.body, kind: o.payload.kind ?? (o.payload.photo ? "photo" : "text"), photo: o.payload.photo, waiting: true }));
    const qs = [...waiting, ...(state.home?.questions ?? [])];
    const title = (q) => q.kind === "callback" ? `${ic("phone")} You asked an officer to call you` : q.body ? esc(q.body) : `${ic("camera")} Photo`;
    return `
      ${errBox()}
      ${state.notice ? `<div class="card notice">${esc(state.notice)}</div>` : ""}
      <form data-form="ask" class="card" style="display:flex;flex-direction:column;gap:10px">
        <label class="field">Your question<textarea name="body" rows="3" maxlength="500" placeholder="My pepper leaves are turning yellow…" style="font:inherit;padding:10px;border-radius:12px;border:1px solid var(--line)"></textarea></label>
        ${state.photo
          ? `<div class="photo-pick"><img src="${state.photo}" alt="Your photo"><button type="button" class="link" data-action="remove-photo">Remove photo</button></div>`
          : `<label class="btn ghost photo-btn">${ic("camera")} Add a photo of the problem<input type="file" accept="image/*" capture="environment" data-action="photo" hidden></label>`}
        <button class="btn">Send to an extension officer</button>
        <small class="muted">The answer comes here and by SMS. A photo helps the officer see the problem.</small>
      </form>
      <button class="btn ghost" data-action="callback" style="width:100%;margin-bottom:12px">${ic("phone")} Ask an officer to call me (free)</button>
      ${qs.map((q) => `<div class="card"><div style="display:flex;justify-content:space-between;gap:8px"><b style="font-size:14.5px">${title(q)}</b>
        <span class="status st-${q.waiting ? "waiting" : q.status}">${q.waiting ? "Waiting to send" : q.status === "answered" ? (q.kind === "callback" ? "Called" : "Answered") : "With officer"}</span></div>
        ${q.photo ? `<img class="q-photo" src="${q.photo}" alt="">` : q.has_photo ? `<div class="muted" style="font-size:13px;margin-top:4px">${ic("camera")} Photo sent</div>` : ""}
        ${q.answer ? `<div class="answer-box"><b>${ic("badge-check")} Extension officer</b><div>${esc(q.answer)}</div></div>` : ""}</div>`).join("")}`;
  },

  profile() {
    appbar("My Profile", true);
    const f = state.home?.farmer;
    if (!f) return `<p class="muted">Connect once to load your profile.</p>`;
    return `
      ${errBox()}
      <div class="card">
        <div class="list-item"><span>Phone</span><b>${esc(f.phone)}</b></div>
        <div class="list-item"><span>County</span><b>${esc(f.county)}</b></div>
        <div class="list-item"><span>Crops</span><b>${esc(f.crops.map((c) => cropName(c.crop)).join(", "))}</b></div>
      </div>
      <div class="card">
        <label class="field">SMS language<select data-action="language">${LANGUAGES.map(([v, l]) => `<option value="${v}" ${f.language === v ? "selected" : ""}>${l}</option>`).join("")}</select></label>
        <label class="check" style="margin-top:10px"><input type="checkbox" data-action="sms" ${f.opted_out_at ? "" : "checked"}> Send me farm advice by SMS</label>
      </div>
      <button class="btn ghost" data-action="signout">Sign out</button>`;
  }
};

// ---------------------------------------------------------------- actions
function signOut(callServer = true) {
  if (callServer && state.token) api("POST", "/api/auth/logout", {}).catch(() => {});
  const content = state.content;
  store.clear();
  Object.assign(state, { token: null, phone: null, home: null, outbox: [], screen: "login", pendingPhone: null, devCode: null, content });
  save();
  render();
}

async function withBusy(fn) {
  state.busy = true; state.error = null; render();
  try { await fn(); } catch (err) { state.error = err.message; }
  state.busy = false; render();
}

const forms = {
  phone: (fd) => withBusy(async () => {
    const r = await api("POST", "/api/auth/request-code", { phone: fd.get("phone") });
    state.pendingPhone = r.phone; state.devCode = r.dev_code ?? null;
  }),
  code: (fd) => withBusy(async () => {
    const r = await api("POST", "/api/auth/verify", { phone: state.pendingPhone, code: fd.get("code") });
    state.token = r.token; state.phone = r.phone; store.set("token", r.token); store.set("phone", r.phone);
    state.pendingPhone = null; state.devCode = null;
    await loadContent();
    if (r.registered) { await refreshHome(); state.screen = "home"; } else state.screen = "register";
  }),
  register: (fd) => withBusy(async () => {
    const crops = fd.getAll("crop").map((crop) => ({ crop, planting_month: Number(fd.get("month-" + crop)) }));
    if (!crops.length) throw new Error("Choose at least one crop.");
    await api("POST", "/api/me/register", {
      name: fd.get("name"), county: fd.get("county"), district: fd.get("district"), language: fd.get("language"),
      consent: fd.get("consent") === "on", crops
    });
    await refreshHome();
    state.screen = "home";
  }),
  pest: (fd) => {
    const symptoms = fd.getAll("symptom");
    state.error = symptoms.length ? null : "Tick at least one thing you see.";
    if (!symptoms.length) return render();
    const crop = fd.get("crop");
    const match = diagnose(symptoms, state.content, crop); // same engine as the server: works offline
    state.outbox.push({ type: "report", payload: { crop, symptoms, client_id: newId() }, at: new Date().toISOString() });
    state.lastResult = { pest: match?.pest ?? null, score: match?.score ?? 0, queued: !online() };
    save(); render(); sync();
  },
  ask: (fd) => {
    const body = String(fd.get("body") ?? "").trim();
    if (!body && !state.photo) { state.error = "Write your question or add a photo."; return render(); }
    state.outbox.push({ type: "question", payload: { body: body || undefined, photo: state.photo ?? undefined, client_id: newId() }, at: new Date().toISOString() });
    state.photo = null; state.error = null;
    state.notice = online() ? "Sent to an extension officer." : "Saved. It will be sent when you have network.";
    save(); render(); sync();
  }
};

document.addEventListener("submit", (e) => {
  const name = e.target.dataset.form;
  if (!name) return;
  e.preventDefault();
  forms[name](new FormData(e.target));
});

document.addEventListener("click", (e) => {
  const go = e.target.closest("[data-go]")?.dataset.go;
  if (go) {
    state.screen = go; state.error = null; state.notice = null; if (go !== "pest") state.lastResult = null; render();
    if (go === "home" || go === "ask" || go === "reports" || go === "weather") refreshHome().then(render);
    if (go === "prices" && (state.market ?? state.content?.markets?.[0]?.id)) loadPrices(state.market ?? state.content.markets[0].id).then(render);
    return;
  }
  const action = e.target.closest("[data-action]")?.dataset.action;
  if (action === "change-phone") { state.pendingPhone = null; state.error = null; render(); }
  if (action === "signout") signOut();
  if (action === "remove-photo") { state.photo = null; render(); }
  if (action === "callback") {
    if (state.outbox.some((o) => o.payload.kind === "callback")) { state.notice = "Your call-back request is already waiting to be sent."; return render(); }
    state.outbox.push({ type: "question", payload: { kind: "callback", client_id: newId() }, at: new Date().toISOString() });
    state.notice = "An officer will call you, free of charge.";
    save(); render(); sync();
  }
});

document.addEventListener("change", async (e) => {
  const action = e.target.dataset.action;
  if (action === "photo") {
    const file = e.target.files?.[0];
    if (!file) return;
    try { state.photo = await shrinkPhoto(file); state.error = null; } catch (err) { state.error = err.message; }
    return render();
  }
  if (action === "task") {
    const key = "done:" + state.home.date, done = store.get(key, {});
    done[e.target.dataset.key] = e.target.checked; store.set(key, done); return;
  }
  if (action === "market") { state.market = e.target.value; save(); render(); await loadPrices(state.market); render(); return; }
  if (action !== "language" && action !== "sms") return;
  try {
    const r = await api("PATCH", "/api/me", action === "language" ? { language: e.target.value } : { sms: e.target.checked });
    state.home.farmer = r.farmer; save();
  } catch (err) { state.error = err.message; }
  render();
});

// ---------------------------------------------------------------- render & start
let shownScreen = null;
function render() {
  if (!state.token) state.screen = "login";
  $("#content").innerHTML = screens[state.screen]();
  if (shownScreen !== state.screen) { $("#content").scrollTop = 0; shownScreen = state.screen; }
  if (state.token && state.screen !== "register") tabbar(); else $("#footer").innerHTML = "";
}

// Typing the 6th digit of the code continues by itself: one less button to find.
document.addEventListener("input", (e) => {
  if (e.target.dataset.action === "code-input" && /^\d{6}$/.test(e.target.value) && !state.busy) e.target.form.requestSubmit();
});

window.addEventListener("online", () => { render(); sync(); });
window.addEventListener("offline", render);

(async function start() {
  render();
  if (state.token) {
    await loadContent();
    await refreshHome();
    render();
    sync();
  }
  setInterval(sync, 30000);
  if ("serviceWorker" in navigator) navigator.serviceWorker.register("sw.js").catch(() => {});
})();
