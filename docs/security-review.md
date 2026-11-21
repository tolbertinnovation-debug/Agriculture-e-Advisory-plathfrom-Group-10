# Security review (Sprint 6, 21 Nov 2026)

AgriConnect holds farmers' phone numbers, names and locations, and sends SMS in the Ministry's name. This review checked the code before the pilot. An external review by someone outside the team is still recommended before scaling past the pilot.

## What was checked

| Area | How | Result |
|---|---|---|
| Dependencies | `npm audit --omit=dev` (express 5, pg 8) | 0 known vulnerabilities |
| Every API route needs the right login | New automated test: lists all 80 routes and calls each without a login | All return 401 except the 16 public routes, which are listed in `test/security.test.js` |
| Permissions per role | Existing tests per role (officer, lead, editor, agronomist, viewer, admin), county limits | OK |
| SQL injection | Every query reviewed: values always go in as `?` parameters | **1 finding, fixed** (backup restore, below) |
| Cross-site scripting | Browser test: farmer name, district, question, staff name and advice text set to `<img src=x onerror=…>`; dashboard, farmer history, content editor and staff page opened | Nothing ran: all pages escape data |
| Spreadsheet formulas in the CSV | Test with `=HYPERLINK(...)` as a farmer name | Exported as text |
| Uploaded photos | Type checked from the file's own bytes, max 600 KB, served with `nosniff` and a no-script policy | OK |
| Passwords, sessions, 2-step login | scrypt; lockout after 5 tries; 12-hour sessions; codes can't be reused; tokens stored only as hashes | OK |
| Farmer sign-in | 6-digit SMS codes, 5 tries, expire, rate-limited | **1 finding, fixed** (codes shown in production, below) |
| Flooding | Per-IP limits on all sign-in routes | **Gap closed**: farmer questions and reports had no limit |
| Browser protections | Security headers | **Added** a Content-Security-Policy |
| Secrets | `.env` never committed; webhook secret compared in constant time; production refuses unsafe settings | OK |

## Findings and fixes

1. **High: sign-in codes were visible in production with the test SMS setting.** With `SMS_PROVIDER=log`, the server returned each farmer's sign-in code in the response and anyone could read a phone's SMS log. That is meant for the local demo, but it also applied on a production server left on that setting, and anyone could then sign in as any farmer. **Fixed:** in production the code is never shown and the message log needs an admin login, whatever the SMS setting. Test: `in production the sign-in code is never shown…`.
2. **Medium: a tampered backup file could run SQL during a restore.** Table and column names were taken from the backup file. **Fixed:** only tables and columns that exist in the database are accepted, and the restore is one transaction, so nothing changes. Test: `a tampered backup file can't run its own SQL…`.
3. **Medium: no limit on farmer questions and reports.** A signed-in phone could flood the officers' queue, or the database with photos. **Fixed:** at most 40 per 10 minutes per signed-in phone. The limit is per phone, not per IP address, because many phones share one mobile-network address. Test included.
4. **Low: no Content-Security-Policy.** **Added:** pages may only load code, styles and pictures from the AgriConnect server and only talk to it; no framing; no plugins. Inline scripts stay allowed because the pages keep their code in the HTML.
5. **Low: "Approve as written" could be clicked while a newer draft was waiting.** **Fixed** in the content editor: the button hides while a draft waits.

## Accepted for the pilot (revisit before scaling)
- **Inline scripts are allowed by the CSP.** Moving page scripts into separate files would allow a stricter policy.
- **Rate limits live in the server's memory.** That is fine for one server; with several servers, use a shared store such as Redis.
- **Photos are stored in the database.** That is fine at pilot size; move them to object storage when photo questions grow.
- **Staff sessions are kept in the browser tab (sessionStorage).** They are cleared when the tab closes, but readable by a script on the page; the CSP and escaping are the protection.
- **The USSD and SMS webhooks trust the gateway's phone number.** This is standard for USSD; `WEBHOOK_SECRET` makes sure only the gateway can call them.

## Before the pilot
- [ ] `npm run preflight` shows READY on the real server (production mode, 2-step login, real SMS provider, webhook secret, backups, no demo accounts)
- [ ] Someone outside the team tries to break in for a day (a free option: a university security class or a local tech hub)
