// Hotspots: the same pest reported several times in one county within a few days.
// Computed live from pest_reports, so it is always up to date.
// Rule (blueprint §4B): 3 or more reports of one pest, same county, within 7 days.
// (By county for now: USSD registration does not ask for the district yet.)

export const HOTSPOT_MIN_REPORTS = 3;
export const HOTSPOT_DAYS = 7;

export function levelFor(reports) {
  if (reports >= 10) return "Outbreak";
  if (reports >= 5) return "Warning";
  return "Watch";
}

export function listHotspots(db, content, { days = HOTSPOT_DAYS, min = HOTSPOT_MIN_REPORTS, county, counties } = {}) {
  const names = Object.fromEntries(content.pests.map((p) => [p.id, p.name]));
  const args = [`-${days} days`];
  let countyFilter = "";
  const list = counties ?? (county ? [county] : null); // counties = an officer's area
  if (list) { countyFilter = `AND county IN (${list.map(() => "?").join(",") || "NULL"})`; args.push(...list); }
  args.push(min);
  const rows = db
    .prepare(
      `SELECT COALESCE(confirmed_pest, suggested_pest) AS pest, county,
              COUNT(*) AS reports,
              SUM(CASE WHEN status = 'verified' THEN 1 ELSE 0 END) AS verified,
              MIN(created_at) AS first_seen, MAX(created_at) AS last_seen
         FROM pest_reports
        WHERE created_at >= datetime('now', ?)
          AND status != 'rejected'
          AND COALESCE(confirmed_pest, suggested_pest) IS NOT NULL
          ${countyFilter}
        GROUP BY 1, 2
       HAVING COUNT(*) >= ?
        ORDER BY reports DESC, last_seen DESC`
    )
    .all(...args);
  return rows.map((r) => ({ ...r, pest_name: names[r.pest] ?? r.pest, level: levelFor(r.reports) }));
}
