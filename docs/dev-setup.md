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
You should see `# pass 28` and `# fail 0`. The tests also run automatically on GitHub every time someone pushes.

## 3. Add demo data and start the API
```bash
npm run seed     # 6 demo farmers + 3 pest reports
npm run dev      # starts on http://localhost:3000 and restarts when you save a file
```

## 4. Try it
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
  src/db.js           database tables
  src/content.js      loads and checks /content
  scripts/seed.js     demo data
  test/               automated tests (node --test)
prototype/            clickable demo screens (no server needed)
```

## API (step 1)

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

## Settings (environment variables)
| Name | Default | Meaning |
|---|---|---|
| `PORT` | `3000` | Port the API listens on |
| `DB_PATH` | `services/api/data/agriconnect.db` | Database file (delete it to start fresh) |
| `CONTENT_DIR` | `content/` | Where the advisory content lives |

## Editing content
1. Edit a file in `content/crops/` or `content/pests.json`.
2. Run `npm test`. It fails if any SMS is longer than 160 characters, stages overlap or a symptom code is unknown.
3. Restart the API.

All content is marked `"status": "draft"` until a CARI or MOA agronomist reviews it.
