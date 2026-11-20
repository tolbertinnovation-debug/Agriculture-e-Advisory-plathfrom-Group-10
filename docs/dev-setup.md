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
You should see `# pass 46` and `# fail 0`. The tests also run automatically on GitHub every time someone pushes.

## 3. Add demo data and start the API
```bash
npm run seed     # 6 demo farmers + 3 pest reports
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

## 5. Try the API directly
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
  src/questions.js    Ask an Expert questions and call-back requests
  src/db.js           database tables
  src/content.js      loads and checks /content
  scripts/seed.js     demo data
  test/               automated tests (node --test)
prototype/            clickable demo screens (no server needed)
```

## API (steps 1–2)

| Method | Path | What it does |
|---|---|---|
| GET | `/health` | Is the server up? |
| GET | `/api/counties` | Liberia's 15 counties |
| GET | `/api/content/crops` | Crop calendars |
| GET | `/api/content/pests` | Symptom codes and pests |
| POST | `/api/farmers` | Register a farmer (needs `consent: true`) |
| GET | `/api/farmers?county=Bong` | List farmers |
| GET | `/api/farmers/:id` | One farmer |
| GET | `/api/farmers/:id/advice` | This week's advice for each crop |
| POST | `/api/pest-reports` | Report a pest; returns diagnosis + reply SMS |
| GET | `/api/pest-reports?county=&status=` | List reports for officers |
| GET | `/api/pest-reports/:id` | One report |
| GET | `/api/stats` | Numbers for the dashboard |
| POST | `/ussd` | USSD gateway webhook (`phoneNumber`, `text`) → `CON …` / `END …` |
| POST | `/sms/inbound` | Incoming SMS (`from`, `text`): HELP, ASK, STOP, START |
| GET | `/api/messages?phone=` | SMS sent and received (the simulator's inbox) |
| GET | `/api/questions?county=&status=` | Questions and call-back requests for officers |

## Settings (environment variables)
| Name | Default | Meaning |
|---|---|---|
| `PORT` | `3000` | Port the API listens on |
| `DB_PATH` | `services/api/data/agriconnect.db` | Database file (delete it to start fresh) |
| `CONTENT_DIR` | `content/` | Where the advisory content lives |
| `SMS_PROVIDER` | `log` | `log` = record messages but don't send them (development) |

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
