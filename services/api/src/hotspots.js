// Hotspots: the same pest reported several times in one county within a few days.
// Computed live from pest_reports, so it is always up to date.
// Rule (blueprint §4B): 3 or more reports of one pest, same county, within 7 days.
// (By county for now: USSD registration does not ask for the district yet.)
import { sqlDaysAgo, sqlNow } from "./db.js";
import { sendSms } from "./messaging.js";

export const HOTSPOT_MIN_REPORTS = 3;
export const HOTSPOT_DAYS = 7;

export function levelFor(reports) {
  if (reports >= 10) return "Outbreak";
  if (reports >= 5) return "Warning";
  return "Watch";
}

export async function listHotspots(db, content, { days = HOTSPOT_DAYS, min = HOTSPOT_MIN_REPORTS, county, counties } = {}) {
  const names = Object.fromEntries(content.pests.map((p) => [p.id, p.name]));
  const args = [sqlDaysAgo(days)];
  let countyFilter = "";
  const list = counties ?? (county ? [county] : null); // counties = an officer's area
  if (list) { countyFilter = `AND county IN (${list.map(() => "?").join(",") || "NULL"})`; args.push(...list); }
  args.push(min);
  const rows = await db.all(
      `SELECT COALESCE(confirmed_pest, suggested_pest) AS pest, county,
              COUNT(*) AS reports,
              SUM(CASE WHEN status = 'verified' THEN 1 ELSE 0 END) AS verified,
              MIN(created_at) AS first_seen, MAX(created_at) AS last_seen
         FROM pest_reports
        WHERE created_at >= ?
          AND status != 'rejected'
          AND COALESCE(confirmed_pest, suggested_pest) IS NOT NULL
          ${countyFilter}
        GROUP BY 1, 2
       HAVING COUNT(*) >= ?
        ORDER BY reports DESC, last_seen DESC, county`,
      ...args
  );
  return rows.map((r) => ({ ...r, pest_name: names[r.pest] ?? r.pest, level: levelFor(r.reports) }));
}

// ---------------------------------------------------------------- alerts to officers
const LEVELS = ["Watch", "Warning", "Outbreak"];

export function hotspotAlertText(h) {
  const what = { Watch: "new hotspot", Warning: "WARNING", Outbreak: "OUTBREAK" }[h.level];
  return `AgriConnect ${what}: ${h.pest_name} in ${h.county}, ${h.reports} reports in ${HOTSPOT_DAYS} days. Check the dashboard and warn farmers.`.slice(0, 160);
}

/**
 * Called after every new pest report. When the report makes a hotspot appear, or raises its level
 * (Watch → Warning → Outbreak), the officers covering that county get one SMS. Admins with a phone
 * get it too. Nothing is sent again for the same pest, county and level within HOTSPOT_DAYS.
 * Returns the alert, or null.
 */
export async function alertOnHotspot(db, content, { pest, county }, { now = new Date() } = {}) {
  if (!pest || !county) return null;
  const h = (await listHotspots(db, content, { county })).find((x) => x.pest === pest);
  if (!h) return null;
  const done = await db.all("SELECT level, sent_to FROM hotspot_alerts WHERE pest = ? AND county = ? AND created_at >= ?", pest, county, sqlDaysAgo(HOTSPOT_DAYS, now));
  // Only tell people when the level is new or higher than anything already sent to someone.
  // (An alert nobody could receive, because no officer had a phone yet, is tried again on the next report.)
  const highest = Math.max(-1, ...done.filter((d) => Number(d.sent_to) > 0).map((d) => LEVELS.indexOf(d.level)));
  if (LEVELS.indexOf(h.level) <= highest) return null;

  const staff = await db.all("SELECT id, role, counties, phone FROM staff WHERE active = 1 AND phone IS NOT NULL AND role IN ('officer', 'admin')");
  const to = staff.filter((s) => s.role === "admin" || JSON.parse(s.counties).includes(county));
  // Nobody to text: note it once (the dashboard shows "no officer phone"), then try again next time.
  if (!to.length && done.some((d) => d.level === h.level)) return null;
  const text = hotspotAlertText(h);
  for (const s of to) await sendSms(db, { phone: s.phone, body: text, kind: "alert", force: true });
  const { id } = await db.get("INSERT INTO hotspot_alerts (pest, county, level, reports, sent_to, created_at) VALUES (?, ?, ?, ?, ?, ?) RETURNING id",
    pest, county, h.level, h.reports, to.length, sqlNow(now));
  return { id, ...h, sent_to: to.length, text };
}

export async function recentHotspotAlerts(db, { counties, limit = 20 } = {}) {
  const where = counties ? `WHERE county IN (${counties.map(() => "?").join(",") || "NULL"})` : "";
  return db.all(`SELECT * FROM hotspot_alerts ${where} ORDER BY id DESC LIMIT ?`, ...(counties ?? []), limit);
}
