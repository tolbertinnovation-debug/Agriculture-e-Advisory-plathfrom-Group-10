# 🌱 AgriConnect Liberia — Agriculture e-Advisory Platform

**RETRAP AgTech Innovation Hackathon 2026 · Group 10**

Expert farming advice for every Liberian farmer, on any phone, in their language, even offline.

## Try the prototype
No install or build is needed. Open these files in any browser:

| Page | What it shows |
|---|---|
| [`prototype/index.html`](prototype/index.html) | Farmer app: home, crop calendar, Pest Doctor, market prices, Ask an Expert, weather, agro-dealers |
| [`prototype/ussd.html`](prototype/ussd.html) | USSD simulator for basic phones: type `*347#` and press SEND |
| [`prototype/dashboard.html`](prototype/dashboard.html) | Extension officer dashboard: county stats, pest hotspots, question queue, send advisory |

For offline mode (service worker), serve the folder instead: `cd prototype && python3 -m http.server 8000`, then open http://localhost:8000.

Useful links: `index.html?screen=market` opens a given screen (`home`, `guide`, `pest`, `market`, `ask`, `weather`, `dealers`). `index.html?demo=diagnosis` shows a Pest Doctor result.

> All prices, counts and forecasts in the prototype are **sample data**.

## Run the platform (all 6 build steps done)
```bash
cd services/api
npm install
npm test        # 99 tests
npm run seed    # demo farmers
npm run dev
```
| Open | What |
|---|---|
| http://localhost:3000/app/ | **Farmer app**: sign in with an SMS code, advice, weather, prices, Pest Doctor; works offline |
| http://localhost:3000/prototype/ussd.html | Basic phone `*347#` simulator with SMS inbox |
| http://localhost:3000/prototype/dashboard.html | Extension officer dashboard |

The USSD simulator and the officer dashboard (`/prototype/dashboard.html`) go **LIVE** when the API is running: register farmers on `*347#`, report pests, watch the hotspot appear on the dashboard, then warn farmers and see the SMS arrive.
Full guide: [docs/dev-setup.md](docs/dev-setup.md). Needs Node.js 22.13 or newer; no database to install.

## Pre-work documents
1. [Frame the problem](docs/01-problem-framing.md)
2. [Talk to real users: interview guide & notes](docs/02-user-interviews.md)
3. [Team roles & tools](docs/03-team-and-tools.md)
- [Full platform blueprint (v2)](docs/blueprint.md): principles, user journeys, MVP scope, USSD design, architecture, API, data model, privacy, risks
- [Plan to build the platform](docs/build-plan.md): 5 phases, hackathon schedule, 6 sprints, pilot, exit criteria
- [Product backlog](docs/backlog.md): user stories with priority and acceptance criteria
- [Screenshots](docs/screenshots/)

## Screens
| Farmer home | Pest Doctor | USSD |
|---|---|---|
| ![home](docs/screenshots/app-home.png) | ![pest](docs/screenshots/app-pest.png) | ![ussd](docs/screenshots/ussd-menu.png) |

![dashboard](docs/screenshots/dashboard.png)
