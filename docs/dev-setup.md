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
You should see `# pass 71` and `# fail 0`. The tests also run automatically on GitHub every time someone pushes.

## 3. Add demo data and start the API
```bash
npm run seed     # 6 demo farmers, 5 pest reports (a Nimba hotspot) and 3 questions
npm run dev      # starts on http://localhost:3000 and restarts when you save a file
```

## 4. Try the basic-phone experience (USSD + SMS)
With the API running, open **http://localhost:3000/prototype/ussd.html**. The badge should say **LIVE**.

1. Click **New** to get a fresh phone number, type `*347#` and press SEND.
2. Choose **1 Register**, then a language, county, crop, planting month and **1 I agree**.
3. The SMS panel shows the welcome message (and this week's advice if your crop is in season).
4. Dial `*347#` again: you now see the full menu. Try **4 Report pest**, **5 Ask an expert**, **6 My profile**.
5. Send an SMS from the panel: `HELP`, `ASK my pepper leaves are yellow`, `STOP`, `START`.

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
- [ ] `OFFICER_TOKEN` set (dashboard access code)
- [ ] `WEBHOOK_SECRET` set, and the gateway URLs end in `?secret=<WEBHOOK_SECRET>`: `/ussd`, `/sms/inbound`, `/sms/status`
- [ ] SMS provider tested with the team's own phones on each network (Lonestar Cell MTN and Orange)
- [ ] All content reviewed by an agronomist (`"status": "draft"` → `"approved"`)
- [ ] HTTPS in front of the server, daily database backups

## 7. Try the API directly
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

## Project layout
```
content/              crop calendars & pest table (JSON). Agronomists edit these; every SMS must be ≤160 characters
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
  src/db.js           database tables
  src/content.js      loads and checks /content
  scripts/seed.js     demo data
  test/               automated tests (node --test)
prototype/            clickable demo screens (no server needed)
```

## API (steps 1–4)

Routes marked 🔒 are officer-only (see `OFFICER_TOKEN` below).

| Method | Path | What it does |
|---|---|---|
| GET | `/health` | Is the server up? |
| GET | `/api/counties` | Liberia's 15 counties |
| GET | `/api/content/crops` | Crop calendars |
| GET | `/api/content/pests` | Symptom codes and pests |
| POST | `/api/farmers` | Register a farmer (needs `consent: true`) |
| GET 🔒 | `/api/farmers?county=Bong` | List farmers |
| GET 🔒 | `/api/farmers/:id` | One farmer |
| GET 🔒 | `/api/farmers/:id/advice` | This week's advice for each crop |
| POST | `/api/pest-reports` | Report a pest; returns diagnosis + reply SMS |
| GET 🔒 | `/api/pest-reports?county=&status=` | List reports for officers |
| GET 🔒 | `/api/pest-reports/:id` | One report |
| GET 🔒 | `/api/stats` | Numbers for the dashboard |
| POST | `/ussd` | USSD gateway webhook (`phoneNumber`, `text`) → `CON …` / `END …` |
| POST | `/sms/inbound` | Incoming SMS (`from`, `text`): HELP, ASK, STOP, START |
| GET 🔒 | `/api/messages?phone=` | SMS sent and received (the simulator's inbox) |
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

## Settings (environment variables)
| Name | Default | Meaning |
|---|---|---|
| `PORT` | `3000` | Port the API listens on |
| `DB_PATH` | `services/api/data/agriconnect.db` | Database file (delete it to start fresh) |
| `CONTENT_DIR` | `content/` | Where the advisory content lives |
| `SMS_PROVIDER` | `log` | `log`, `africastalking` or `http`; see section 6 |
| `ADVICE_HOUR` | `7` | Hour (Liberia time = UTC) for the daily crop advice |
| `SCHEDULER` | *(on)* | `off` = don't run the daily advice job |
| `WEBHOOK_SECRET` | *(unset)* | When set, `/ussd`, `/sms/inbound` and `/sms/status` need `?secret=…` or header `X-Webhook-Secret` |
| `OFFICER_TOKEN` | *(unset)* | Access code for 🔒 officer routes. Unset = open (fine on your laptop). **Always set it on a server others can reach**; the dashboard then asks for it. Real staff accounts come in MVP Sprint 1. |

## USSD menu (live)
```
*347#  (new number)                  *347#  (registered farmer)
1 Register (free)                    1 Crop advice  → this week's tip → 1 Get by SMS
  language → county (2 pages)        2 Weather          (coming in step 6)
  → crop → planting month            3 Market prices    (coming in step 6)
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
