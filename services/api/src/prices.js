// Market prices. Trusted market reporters send one SMS per price:
//     PRICE GBARNGA RICE 45
// Prices that look very different from the last week's (more than 50% up or down)
// are "flagged" and wait for an officer before farmers see them, so one typing mistake
// (450 instead of 45) never misleads farmers.
import { ValidationError } from "./farmers.js";
import { normalizePhone } from "./geo.js";

export const OUTLIER_RATIO = 1.5;  // flagged if > 1.5x or < 1/1.5 of the recent median
const DAY = 24 * 3600 * 1000;

const byCode = (list, code) => list.find((x) => x.code === String(code ?? "").toUpperCase() || x.id === code);
export const findMarket = (content, code) => byCode(content.markets, code);
export const findItem = (content, code) => byCode(content.items, code);

function median(values) {
  const s = [...values].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

/** Record one price. Returns the stored price (status ok or flagged). */
export function recordPrice(ctx, { market, item, price, reporter }) {
  const { db, content } = ctx;
  const m = findMarket(content, market);
  const it = findItem(content, item);
  const value = Number(price);
  const errors = [];
  if (!m) errors.push(`market: unknown market "${market}" (use ${content.markets.map((x) => x.code).join(", ")})`);
  if (!it) errors.push(`item: unknown item "${item}" (use ${content.items.map((x) => x.code).join(", ")})`);
  if (!Number.isFinite(value) || value <= 0 || value > 1_000_000) errors.push("price: a number in LRD, e.g. 45");
  if (errors.length) throw new ValidationError(errors);

  const now = ctx.now();
  const recent = db
    .prepare("SELECT price_lrd FROM prices WHERE market = ? AND item = ? AND status = 'ok' AND reported_at >= ?")
    .all(m.id, it.id, new Date(now.getTime() - 14 * DAY).toISOString())
    .map((r) => r.price_lrd);
  let status = "ok";
  if (recent.length >= 2) {
    const mid = median(recent);
    if (value > mid * OUTLIER_RATIO || value < mid / OUTLIER_RATIO) status = "flagged";
  }
  const { lastInsertRowid } = db
    .prepare("INSERT INTO prices (market, item, price_lrd, reporter, status, reported_at) VALUES (?, ?, ?, ?, ?, ?)")
    .run(m.id, it.id, value, reporter ?? null, status, now.toISOString());
  return { ...db.prepare("SELECT * FROM prices WHERE id = ?").get(lastInsertRowid), market_name: m.name, item_name: it.name, unit: it.unit };
}

/**
 * Latest price of each item at a market (last 7 days, status ok), with the change
 * against the average of the 7 days before that.
 */
export function latestPrices(ctx, marketCode) {
  const { db, content } = ctx;
  const m = findMarket(content, marketCode);
  if (!m) return null;
  const now = ctx.now().getTime();
  const iso = (ms) => new Date(ms).toISOString();
  const items = [];
  for (const it of content.items) {
    const latest = db.prepare("SELECT price_lrd, reported_at FROM prices WHERE market = ? AND item = ? AND status = 'ok' AND reported_at >= ? ORDER BY reported_at DESC LIMIT 1")
      .get(m.id, it.id, iso(now - 7 * DAY));
    if (!latest) continue;
    const before = db.prepare("SELECT AVG(price_lrd) AS avg FROM prices WHERE market = ? AND item = ? AND status = 'ok' AND reported_at >= ? AND reported_at < ?")
      .get(m.id, it.id, iso(now - 14 * DAY), iso(now - 7 * DAY)).avg;
    items.push({
      item: it.id, name: it.name, code: it.code, unit: it.unit,
      price_lrd: latest.price_lrd, reported_at: latest.reported_at,
      change_pct: before ? Math.round(((latest.price_lrd - before) / before) * 100) : null
    });
  }
  return { market: m.id, market_name: m.name, county: m.county, items };
}

export function allLatestPrices(ctx) {
  return ctx.content.markets.map((m) => latestPrices(ctx, m.id));
}

export function listFlaggedPrices(ctx) {
  const { db, content } = ctx;
  return db.prepare("SELECT * FROM prices WHERE status = 'flagged' ORDER BY id DESC LIMIT 50").all().map((p) => ({
    ...p,
    market_name: findMarket(content, p.market)?.name ?? p.market,
    item_name: findItem(content, p.item)?.name ?? p.item
  }));
}

export function setPriceStatus(db, id, status) {
  if (!["ok", "rejected"].includes(status)) throw new ValidationError(["status: ok or rejected"]);
  return db.prepare("UPDATE prices SET status = ? WHERE id = ?").run(status, id).changes > 0;
}

// ---- reporters ----
export function addReporter(ctx, { phone, name, market }) {
  const p = normalizePhone(phone);
  const m = findMarket(ctx.content, market);
  const errors = [];
  if (!p) errors.push("phone: not a valid Liberian mobile number");
  if (!m) errors.push("market: unknown market");
  if (errors.length) throw new ValidationError(errors);
  ctx.db.prepare("INSERT INTO market_reporters (phone, name, market, active) VALUES (?, ?, ?, 1) ON CONFLICT(phone) DO UPDATE SET name = excluded.name, market = excluded.market, active = 1")
    .run(p, typeof name === "string" ? name.slice(0, 80) : null, m.id);
  return getReporter(ctx.db, p);
}
export function getReporter(db, phone) {
  const r = db.prepare("SELECT * FROM market_reporters WHERE phone = ? AND active = 1").get(phone);
  return r ? { ...r } : null;
}
export function listReporters(db) {
  return db.prepare("SELECT * FROM market_reporters WHERE active = 1 ORDER BY market, name").all().map((r) => ({ ...r }));
}

/** One short price list for SMS / USSD, best effort within `max` characters. */
export function priceText(list, max = 160) {
  let text = `${list.market_name.toUpperCase()} (LRD):`;
  for (const it of list.items) {
    const line = `\n${it.code} ${it.price_lrd}/${it.unit}`;
    if ((text + line).length > max) break;
    text += line;
  }
  return list.items.length ? text : `${list.market_name}: no prices this week yet.`;
}
