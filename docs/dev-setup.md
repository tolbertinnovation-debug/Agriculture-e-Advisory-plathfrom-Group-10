# Developer setup: run AgriConnect on your laptop

You need **Node.js 22.13 or newer** (download the LTS version from nodejs.org) and **Git**. No database is needed: the API uses SQLite, which is built into Node.js.

## 1. Get the code
```bash
git clone https://github.com/tolbertinnovation-debug/Agriculture-e-Advisory-plathfrom-Group-10.git
cd Agriculture-e-Advisory-plathfrom-Group-10/services/api
npm install
```

## 2. Run the tests
```bash
npm test
```
You should see `# pass 134` and `# fail 0`.

To run the same tests on PostgreSQL (what servers use), start one with Docker and point the tests at it:
```bash
docker run -d --name agri-pg -e POSTGRES_PASSWORD=devpass -p 5433:5432 postgres:16-alpine
TEST_DATABASE_URL=postgres://postgres:devpass@127.0.0.1:5433/postgres npm test
```
Each test gets its own empty schema, which is dropped afterwards. GitHub runs both. The tests also run automatically on GitHub every time someone pushes.

## 3. Add demo data and start the API
```bash
npm run seed     # demo farmers, pest reports (a Nimba hotspot), questions, market reporters, 2 weeks of sample prices, a sample forecast, demo staff logins
npm run dev      # starts on http://localhost:3000 and restarts when you save a file
```

### Staff logins (officer dashboard)
Everyone who uses the dashboard has their own account. `npm run seed` creates these **local demo** logins (never use them on a real server):

| Role | Email | Password | Can |
|---|---|---|---|
| admin | admin@agriconnect.test | demo-admin-2026 | everything, incl. staff accounts and the audit log |
| officer | mulbah@agriconnect.test | demo-officer-2026 | reports, questions, hotspots and advisories for **Bong, Lofa, Nimba only** |
| editor | editor@agriconnect.test | demo-editor-2026 | market prices, reporters, weather refresh, advice job |
| viewer | partner@agriconnect.test | demo-viewer-2026 | numbers and hotspots only, no personal data |

**Staff & security page** (`/prototype/staff.html`, linked from the dashboard):
- **Everyone** can change their password and turn on **2-step login**: a 6-digit code from an authenticator app (Google Authenticator, Microsoft Authenticator, Authy) on top of the password.
- **Admins** create accounts (the first password is shown once), change roles and counties, reset passwords, switch accounts off (which logs them out at once), and read the **audit log** of who did what.

Security rules: passwords are hashed with scrypt; 5 wrong tries lock an account for 15 minutes; sessions end after 12 hours; officers can only see and message farmers in their own counties.

**On a real server**, create the first admin with
```bash
npm run create-admin -- you@example.org "Your Name"
```
The password is printed once. Log in, change it and turn on 2-step login. Set `REQUIRE_2FA=1` so every staff member must use it.

## 4. Try the basic-phone experience (USSD + SMS)
With the API running, open **http://localhost:3000/prototype/ussd.html**. The badge should say **LIVE**.

1. Click **New** to get a fresh phone number, type `*347#` and press SEND.
2. Choose **1 Register**, then a language, county, crop, planting month and **1 I agree**.
3. The SMS panel shows the welcome message (and this week's advice if your crop is in season).
4. Dial `*347#` again: you now see the full menu. Try **4 Report pest**, **5 Ask an expert**, **6 My profile**.
5. Send an SMS from the panel: `HELP`, `ASK my pepper leaves are yellow`, `WEATHER`, `PRICES GBARNGA`, `STOP`, `START`. To try reporting a price, set the phone to a seeded reporter (`0886000002` = Gbarnga) and send `PRICE GBARNGA RICE 47`.

The simulator talks to the API exactly like a telco gateway: `POST /ussd` with `phoneNumber` and `text` (all answers joined by `*`), and the API answers `CON …` (wait for the next answer) or `END …` (close). When we get a real short code, the gateway points to the same URL.

## 5. Try the officer dashboard (the full loop)
Open **http://localhost:3000/prototype/dashboard.html** next to the USSD simulator. The badge says **LIVE data**, and it refreshes every 5 seconds.

1. On the simulator, register 3 farmers in the same county (use **New** for each number) and have each report *Worms eating leaves* (`*347#` → 4 → 1 → 1).
2. On the dashboard, a **hotspot** appears for that county (3+ reports of one pest, same county, 7 days).
3. Click **Verify** on a report: the farmer gets an SMS saying an officer confirmed it.
4. Answer a question in **Farmer questions**: the reply arrives on the farmer's phone. For call-back requests, click **Mark as called** after you call.
5. Click **Warn farmers** on the hotspot: the advisory form fills in. Check the reach number, then **Send to farmers**. The warning arrives on every matching phone in the simulator.

## 6. Automatic crop advice and real SMS (step 4)
**How messages flow.** Every SMS is first saved in a queue (`message_log`, status `queued`). A background sender inside the API delivers queued messages every 2 seconds through the SMS provider. If the provider is down, it retries after 2 and then 4 minutes, and after 3 attempts marks the message `failed`. Delivery reports from the provider (`POST /sms/status`) turn `sent` into `delivered`. A broadcast to thousands of farmers returns at once.

**Daily crop advice.** Every day at 07:00 Liberia time (`ADVICE_HOUR`), each farmer gets the advice for their crop's current stage:
- only when they reach a **new stage**, with a reminder at most every **28 days** in long stages;
- at most **3 advice SMS per farmer per week**;
- never to farmers who replied STOP, and nothing between seasons.

If the server starts after 07:00 and today's run hasn't happened, it runs straight away. On the dashboard, the **Automatic advice & SMS** card shows the next run, the last result and the SMS counts. Use **Preview** (sends nothing) or **Send due advice now**. Set `SCHEDULER=off` to stop the daily job, e.g. while testing.

**Connect a real SMS company.** Nothing else in the code changes: choose the provider with environment variables.

| `SMS_PROVIDER` | Settings | Notes |
|---|---|---|
| `log` (default) | none | Development. Messages are recorded and shown in the simulator, never sent. |
| `africastalking` | `AT_USERNAME`, `AT_API_KEY`, optional `AT_SENDER_ID`, `AT_SANDBOX=1` | Also offers USSD in the same `CON/END` format our `/ussd` uses. **Confirm it covers Liberian networks for your account first.** Point its delivery-report URL to `/sms/status`. |
| `http` | `SMS_HTTP_URL`, `SMS_HTTP_TOKEN`, optional `SMS_SENDER_ID` | Any provider or telco with a simple JSON API: we POST `{to, message, from}` with `Authorization: Bearer <token>`. If theirs differs, copy `httpProvider` in `src/providers/index.js` and adjust. |

Example (Mac/Linux; on Windows use `set NAME=value` first):
```bash
SMS_PROVIDER=africastalking AT_USERNAME=sandbox AT_API_KEY=your-key AT_SANDBOX=1 npm start
```
**Never put keys in the code or commit them to GitHub.** Use environment variables or your hosting platform's "secrets" settings.

### Checklist before real farmers use it
- [ ] First admin created with `npm run create-admin`, and **no** demo accounts (never run `npm run seed` on the server)
- [ ] `REQUIRE_2FA=1` set, so every staff member uses 2-step login
- [ ] `STAFF_AUTH` **not** set to `off`
- [ ] `WEBHOOK_SECRET` set, and the gateway URLs end in `?secret=<WEBHOOK_SECRET>`: `/ussd`, `/sms/inbound`, `/sms/status`
- [ ] SMS provider tested with the team's own phones on each network (Lonestar Cell MTN and Orange)
- [ ] All content reviewed by an agronomist (`"status": "draft"` → `"approved"`)
- [ ] HTTPS in front of the server, daily database backups

## 7. The farmer smartphone app (step 5)
Open **http://localhost:3000/app/**. To see it like a phone, open your browser's developer tools and use the phone view.

1. Enter any Liberian number and tap **Send me a code**. In development the 6-digit code shows on screen, because nothing is really sent. With a real SMS provider it arrives by SMS only.
2. Register: county, district, language, crops and planting months, and consent.
3. **Home** shows pest alerts for your county, the officer's advisories and this week's advice for each crop.
4. Turn on airplane mode, or in developer tools go to **Network → Offline**. Pest Doctor still works and gives the same diagnosis as the server, because it runs the same engine. The report and any question are saved on the phone ("Offline · 2 waiting").
5. Close and reopen the app while offline: it still opens with your advice.
6. Go back online: everything waiting is sent within seconds (or every 30 seconds), never twice. Answers from officers appear under **Ask**.

How it works:
- **Sign-in:** phone + one-time SMS code; no password. Codes expire after 10 minutes; 5 wrong tries lock a code; at most 3 codes per 15 minutes; sessions last 90 days.
- **Offline:** the service worker (`apps/farmer/sw.js`) keeps the app itself on the phone. `app.js` keeps the farmer's data in the phone's storage, plus an outbox of reports and questions. Each item has a `client_id`, so a retried send is recognised and not duplicated.
- **Security:** farmers can only see and change their own data. Registering someone else (`POST /api/farmers`) and filing reports for others (`POST /api/pest-reports`) are now officer-only.

Install on a phone: when the API runs on a server with HTTPS, open `/app/` in Chrome on Android and choose **Add to Home screen**.

## 8. Weather and market prices (step 6)
**Weather.** Every 3 hours the server fetches a 5-day forecast for each county capital from **Open-Meteo**, which is free and needs no key. It turns the forecast into farm advice:
- **Heavy rain** (chance ≥ 70% or ≥ 20 mm in the next 2 days): "Don't spray or apply fertilizer… wait until Sun. Clear drainage." Farmers in that county get an SMS alert between 06:00 and 19:00, at most once every 3 days.
- **Hot and dry**: water seedlings early or late; mulch.
- **Otherwise**: the good days to spray or apply fertilizer.

Farmers see it on `*347#` option 2, by SMS `WEATHER`, and in the app (home card + Weather screen). Officers see every county on the dashboard and can click **Refresh now**. If the server cannot reach Open-Meteo, the last forecast is kept. `npm run seed` adds a **sample** forecast, clearly labelled, so the demo works without internet.

The rain and temperature limits are drafts in `src/weather.js` (`HEAVY_RAIN_PROB`, `HEAVY_RAIN_MM`, `GOOD_DAY_PROB`). Agree them with MOA / CARI.

**Market prices.**
1. An officer adds trusted market reporters (dashboard → Market prices → *Market reporters · add one*).
2. A reporter sends one SMS per price: `PRICE GBARNGA RICE 45`. Market and item codes are in `content/markets.json`.
3. A price more than 50% away from the recent prices for that item at that market is **flagged**. Farmers don't see it until an officer clicks **Accept** (so a typo like 450 for 45 never misleads anyone).
4. Farmers see the latest prices and the change from last week: `*347#` option 3 (their county's market first), SMS `PRICES GBARNGA`, or the app's Prices screen (works offline with the last prices).

## 9. Try the API directly
Open these in your browser:
- http://localhost:3000/health
- http://localhost:3000/api/stats: farmers by county
- http://localhost:3000/api/farmers: all farmers
- http://localhost:3000/api/farmers/1/advice: this week's advice for farmer 1
- http://localhost:3000/api/pest-reports?county=Nimba

Report a pest (Mac/Linux terminal, or Git Bash on Windows):
```bash
curl -X POST http://localhost:3000/api/pest-reports \
  -H "Content-Type: application/json" \
  -d '{"phone":"0770000001","crop":"rice","symptoms":["holes","caterpillar"],"channel":"ussd"}'
```
The reply includes the likely pest and the SMS the farmer would receive.

Register a farmer:
```bash
curl -X POST http://localhost:3000/api/farmers \
  -H "Content-Type: application/json" \
  -d '{"phone":"0777 555 111","name":"Test Farmer","county":"Lofa","consent":true,"crops":[{"crop":"rice","planting_month":5}]}'
```

### Database: SQLite or PostgreSQL
The same code runs on both. On a laptop nothing is needed: SQLite is built into Node.js. On a server, set `DATABASE_URL` (Docker Compose does this for you) and AgriConnect uses PostgreSQL. The tables are created and updated automatically by numbered **migrations** (`MIGRATIONS` in `src/db.js`, recorded in the `schema_migrations` table). To change the database later, add a new migration at the end; never edit one that has already run on a server.

Writing code that touches the database: every call is `await db.get / all / run / exec / tx(...)`, use `?` placeholders, `INSERT … RETURNING id` for new ids, and pass times as parameters (`sqlNow()`, `sqlDaysAgo()`), never database time functions. Run the tests on both databases before pushing.

## Project layout
```
content/              crop calendars, pest table, markets & price items (JSON). Agronomists edit these; every SMS must be ≤160 characters
services/api/
  src/server.js       starts the API
  src/app.js          all HTTP routes
  src/engine.js       advisory engine: crop stage by planting month, pest diagnosis
  src/farmers.js      registration & farmer data
  src/pestReports.js  pest reports & SMS replies
  src/ussd.js         *347# menus (register, advice, report pest, ask expert, profile)
  src/smsInbound.js   incoming SMS keywords: HELP, ASK, STOP, START
  src/messaging.js    outgoing SMS (logged; real telco provider comes in step 4)
  src/questions.js    Ask an Expert questions, call-back requests and officer answers
  src/hotspots.js     hotspot rule: 3+ reports of one pest in one county within 7 days
  src/broadcasts.js   officer advisories to many farmers (by county and crop, skips STOP)
  src/scheduler.js    daily crop advice job (stage changes, 28-day reminders, 3/week cap) + background sender
  src/providers/      SMS providers: log (development), africastalking, http
  src/auth.js         farmer sign-in: SMS codes and sessions
  src/farmerApi.js    farmer app API: /api/auth/*, /api/me/*
  src/weather.js      Open-Meteo forecasts per county, farm advice from the forecast, rain alerts
  src/prices.js       market prices: SMS reports, unusual-price check, latest prices with weekly change
apps/farmer/          the real farmer app (offline PWA): index.html, app.js, sw.js, styles.css
  src/db.js           database tables
  src/content.js      loads and checks /content
  scripts/seed.js     demo data
  test/               automated tests (node --test)
prototype/            clickable demo screens for the pitch (no server needed)
```

## API (steps 1–6)

Routes marked 🔒 need a staff login (`Authorization: Bearer <token>` from `POST /api/staff/login`) and a role that allows them. For officers, lists and actions are limited to their own counties.

| Method | Path | What it does |
|---|---|---|
| GET | `/health` | Is the server up? |
| GET | `/api/counties` | Liberia's 15 counties |
| GET | `/api/content/crops` | Crop calendars |
| GET | `/api/content/pests` | Symptom codes and pests |
| POST 🔒 | `/api/farmers` | Assisted registration by an officer (needs `consent: true`) |
| GET 🔒 | `/api/farmers?county=Bong` | List farmers |
| GET 🔒 | `/api/farmers/:id` | One farmer |
| GET 🔒 | `/api/farmers/:id/advice` | This week's advice for each crop |
| POST 🔒 | `/api/pest-reports` | Report a pest for a farmer; returns diagnosis + reply SMS |
| GET 🔒 | `/api/pest-reports?county=&status=` | List reports for officers |
| GET 🔒 | `/api/pest-reports/:id` | One report |
| GET 🔒 | `/api/stats` | Numbers for the dashboard |
| POST | `/ussd` | USSD gateway webhook (`phoneNumber`, `text`) → `CON …` / `END …` |
| POST | `/sms/inbound` | Incoming SMS (`from`, `text`): HELP, ASK, STOP, START |
| GET 🔒 | `/api/messages?phone=` | SMS log (admin only; one phone's inbox is open in development for the simulator) |
| GET 🔒 | `/api/questions?county=&status=` | Questions and call-back requests for officers |
| PATCH 🔒 | `/api/pest-reports/:id` | `{status: verified\|rejected\|closed, confirmed_pest}`; verifying SMSes the farmer |
| PATCH 🔒 | `/api/questions/:id` | `{answer, answered_by}`; the answer goes to the farmer by SMS (max 139 chars) |
| GET 🔒 | `/api/hotspots?county=&days=7` | Pests reported 3+ times in one county |
| POST 🔒 | `/api/broadcasts/preview` | `{counties, crops}` → how many farmers it would reach |
| POST 🔒 | `/api/broadcasts` | `{counties, crops, channels, message}` → sends the SMS |
| GET 🔒 | `/api/broadcasts` | Advisories already sent |
| GET 🔒 | `/api/jobs` | Daily advice schedule, last runs, SMS queue counts |
| POST 🔒 | `/api/jobs/advice/run` | `{dry_run: true}` to preview, `{}` to send due advice now |
| POST | `/sms/status` | Delivery reports from the SMS provider: `{id, status}` |
| GET | `/api/weather?county=Bong` | Forecast + farm advice for a county (all counties without `county`) |
| GET | `/api/markets` | Markets and price items |
| GET | `/api/prices?market=GBARNGA` | Latest prices with weekly change (all markets without `market`) |
| POST 🔒 | `/api/prices` | `{market, item, price}`: officer enters a price |
| GET 🔒 | `/api/prices/flagged` | Unusual prices waiting for a check |
| PATCH 🔒 | `/api/prices/:id` | `{status: ok \| rejected}` |
| GET / POST 🔒 | `/api/reporters` | List / add market reporters `{phone, name, market}` |
| POST | `/api/staff/login` | `{email, password, code?}` → `{token, staff}` (`needs_code` when 2-step login is on) |
| POST 🔒 | `/api/staff/logout` | End this session |
| GET 🔒 | `/api/staff/me` | Who am I, role, counties, permissions |
| POST 🔒 | `/api/staff/me/password` | `{current, new}` |
| POST 🔒 | `/api/staff/me/2fa/start` · `/enable` · `/disable` | Set up 2-step login (`enable` takes `{code}`, `disable` takes `{password}`) |
| GET / POST 🔒 | `/api/staff` | Admin: list / create staff `{email, name, role, counties}` (the password is returned once) |
| PATCH 🔒 | `/api/staff/:id` | Admin: `{name, role, counties, active}` |
| POST 🔒 | `/api/staff/:id/reset-password` | Admin: new one-time password (`{reset_2fa: true}` also resets 2-step login) |
| GET 🔒 | `/api/audit` | Admin: audit log |
| GET 🔒 | `/api/admin/status` | Admin: backups, SMS, weather, advice, errors, warnings |
| POST 🔒 | `/api/admin/backup` | Admin: back up now (needs `BACKUP_DIR`) |
| GET | `/ready` | 200 only when the app and its database answer (for Docker and uptime monitors) |
| POST 🔒 | `/api/jobs/weather/run` | Fetch all county forecasts now (and send due rain alerts) |
| POST | `/api/auth/request-code` | `{phone}` → SMS with a 6-digit code (`dev_code` in the answer only when `SMS_PROVIDER=log`) |
| POST | `/api/auth/verify` | `{phone, code}` → `{token, registered}` |
| POST 👤 | `/api/auth/logout` | End this session |
| GET 👤 | `/api/me` | Who am I, am I registered |
| POST 👤 | `/api/me/register` | Register yourself (phone comes from the sign-in) |
| PATCH 👤 | `/api/me` | `{language, sms: true/false}` |
| GET 👤 | `/api/me/home` | Profile, this week's advice, county alerts, my reports and questions |
| POST 👤 | `/api/me/reports` | `{crop, symptoms, client_id}`; same `client_id` twice = no duplicate |
| POST 👤 | `/api/me/questions` | `{body, client_id}` |

👤 = needs the farmer's sign-in token (`Authorization: Bearer <token>`).

## Settings (environment variables)
| Name | Default | Meaning |
|---|---|---|
| `PORT` | `3000` | Port the API listens on |
| `DATABASE_URL` | *(unset)* | `postgres://user:password@host:5432/db` → use PostgreSQL (servers). Unset → SQLite file at `DB_PATH` (laptops) |
| `DB_PATH` | `services/api/data/agriconnect.db` | SQLite database file (delete it to start fresh) |
| `CONTENT_DIR` | `content/` | Where the advisory content lives |
| `SMS_PROVIDER` | `log` | `log`, `africastalking` or `http`; see section 6 |
| `ADVICE_HOUR` | `7` | Hour (Liberia time = UTC) for the daily crop advice |
| `SCHEDULER` | *(on)* | `off` = don't run the daily advice job |
| `WEATHER` | *(on)* | `off` = don't fetch forecasts |
| `WEATHER_URL` | Open-Meteo | Another server with the same format (used for testing) |
| `WEBHOOK_SECRET` | *(unset)* | When set, `/ussd`, `/sms/inbound` and `/sms/status` need `?secret=…` or header `X-Webhook-Secret` |
| `REQUIRE_2FA` | *(off)* | `1` = every staff member must set up 2-step login before using the dashboard. **Set it on a real server.** |
| `STAFF_AUTH` | *(on)* | `off` = the dashboard needs no login (quick local demo only; never on a shared server) |
| ~~`OFFICER_TOKEN`~~ | | Removed: replaced by personal staff accounts |
| `NODE_ENV` | *(unset)* | `production` on a real server: HTTPS headers, CORS closed, unsafe settings refused |
| `BACKUP_DIR` | *(off)* | Folder for daily checked backups (`/backups` in Docker) |
| `BACKUP_HOUR` / `BACKUP_KEEP` | `2` / `14` | When to back up (Liberia time) and how many to keep |
| `ERROR_WEBHOOK_URL` | *(unset)* | Slack / Discord / Teams webhook for server-error alerts |
| `TRUST_PROXY` | *(off)* | `1` behind Caddy or a load balancer (set in the Docker image) |
| `CORS_ORIGINS` | `*` in development, none in production | Other websites allowed to call the API |

**Putting it on a server:** see [deploy.md](deploy.md) (Docker + HTTPS + backups).

## USSD menu (live)
```
*347#  (new number)                  *347#  (registered farmer)
1 Register (free)                    1 Crop advice  → this week's tip → 1 Get by SMS
  language → county (2 pages)        2 Weather → 3-day forecast + advice → 1 Get by SMS
  → crop → planting month            3 Market prices → market → prices → 1 Get by SMS
  → consent → welcome SMS            4 Report pest → what you see → crop → SMS reply + Ref
2 Report pest (asks county)          5 Ask an expert → call-back request / how to ASK by SMS
3 Ask an expert (asks county)        6 My profile → change language / stop or start SMS
```
Menu wording lives in `services/api/src/ussd.js`; the pest symptoms and crops shown in the USSD menus live in `content/pests.json` (`ussd_symptoms`, `report_crops`). Every screen is tested to fit in 182 characters.

## Editing content
1. Edit a file in `content/crops/` or `content/pests.json`.
2. Run `npm test`. It fails if any SMS is longer than 160 characters, stages overlap or a symptom code is unknown.
3. Restart the API.

All content is marked `"status": "draft"` until a CARI or MOA agronomist reviews it.
