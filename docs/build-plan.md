# AgriConnect Liberia: Plan to Build the Platform

This plan takes AgriConnect from the clickable prototype in `prototype/` to a pilot with real farmers, and then to all 15 counties.
What we are building is described in **[blueprint.md](blueprint.md)**; the user stories are in **[backlog.md](backlog.md)**.

```
Phase 0        Phase 1          Phase 2               Phase 3              Phase 4
Prepare   →    Hackathon   →    MVP build        →    Pilot           →    Scale
(now)          (event days)     (12 weeks, 6 sprints) (6 months,           (all 15 counties)
                                                      Bong + Nimba)
```

---

## Phase 0: Prepare (before the hackathon)

| # | Task | Owner | Done when |
|---|---|---|---|
| 0.1 | Finish the pre-work: problem page, 2+ interviews, roles | Team lead | Shared in the team WhatsApp group |
| 0.2 | Turn interview notes into 3–5 **design changes** | Researcher | Listed in `docs/02-user-interviews.md` |
| 0.3 | ✅ **Stack chosen: Node.js (Express) + SQLite for development, PostgreSQL before the pilot.** Reason: the prototype is already JavaScript, so the team uses one language end to end | Backend dev | Done |
| 0.4 | Create a sandbox account with an SMS/USSD aggregator that covers Liberia, or plan to demo with the USSD simulator | Backend dev | Test SMS received on a team phone, or simulator ready |
| 0.5 | Write the first content: rice and cassava × 6 stages, top 6 pests (English) | Content lead | Reviewed by an agronomist or extension officer |
| 0.6 | Set up the repo: folders (below), README, issue labels, the backlog as GitHub issues | Team lead | Every Must story is an issue with an owner |
| 0.7 | Figma: USSD flow + 5 key app screens, updated with interview insights | Designer | Linked in `docs/03-team-and-tools.md` |
| 0.8 | Book 2–3 farmers or an officer reachable by phone during the hackathon for quick tests | Researcher | Names and times agreed |

### Repository layout (target)
```
prototype/            clickable demo (already built, keep for the pitch)
apps/farmer-pwa/      real farmer app (offline PWA)
apps/dashboard/       officer + content editor web app
services/api/         REST API, USSD and SMS webhooks
services/worker/      scheduled advice, message queue, hotspot detection
content/              advisories & pest tables as JSON/YAML (reviewed by agronomists)
docs/                 blueprint, plans, research, screenshots
```

---

## Phase 1: Hackathon build

**Goal:** a demo in which a pest report travels all the way from a basic phone to an officer and back as an advisory to many farmers. This is the core loop (blueprint §4B).

*Assumes a 2-day event; stretch or shrink the blocks to match the real schedule.*

| When | Frontend / design | Backend | Content / research | Pitch |
|---|---|---|---|---|
| **Day 1 morning** | Set up the PWA from `prototype/`, connect it to the API | API skeleton, database tables: farmers, pest_reports, questions, advisories | Load the rice/cassava content and pest table into `content/` | Pitch outline |
| **Day 1 afternoon** | Registration and Pest Doctor talk to the API | USSD webhook: register + report pest; SMS reply with 3 steps | Write the USSD and SMS wording (≤160 characters) | Collect photos and quotes |
| **Day 1 evening** | Dashboard: live pest reports + question queue | Hotspot rule (≥3 reports, same district, 7 days); broadcast endpoint | Test the USSD flow with a farmer by phone | Draft slides |
| **Day 2 morning** | Dashboard: send advisory screen, hotspot list | Broadcast → SMS queue; seed demo data | Fix wording from the test | Demo script |
| **Day 2 midday** | **Feature freeze.** Fix bugs, polish | Deploy to one server; test on real phones | Final content check | Rehearse twice |
| **Day 2 afternoon** | | | | **Present** |

**Demo script (3 minutes)**
1. Kollie dials `*347#` on a basic phone and reports worms eating leaves.
2. Kollie gets an SMS with 3 steps.
3. The officer dashboard shows a new hotspot in Bong.
4. The officer sends an advisory, and the phones in the room receive it.
5. The app opens offline and shows the same advice.

**Hackathon Must list:** registration (USSD + app), pest report and reply, officer dashboard with queue, hotspots and broadcast, and a working seasonal-advice SMS.
**Cut first if short on time:** weather, prices, voice, photo upload.

---

## Phase 2: MVP build (12 weeks after the hackathon)

Work in **2-week sprints**. Each sprint ends with a demo to a farmer or officer and a short retrospective.

| Sprint | Weeks | Goal | Key deliverables |
|---|---|---|---|
| **1** | 1–2 | Solid foundation | Final stack; CI (tests run on every push); staging server; staff login with roles; data model and migrations; error tracking |
| **2** | 3–4 | Farmers can join and receive advice | Registration over USSD, app and assisted sign-up (lead farmer); consent and `STOP`; advisory engine v1 (stage by planting month); daily scheduler; SMS log |
| **3** | 5–6 | Pest loop works end to end | Pest Doctor (symptom table) in USSD and app; officer verification; automatic hotspots; broadcast by county, crop and channel; delivery reports |
| **4** | 7–8 | Questions and offline | Ask an Expert (text, photo, call-back request); routing by district; 24 h escalation; PWA offline cache + background sync |
| **5** | 9–10 | Weather, prices, content tools | Weather API + rain override rules; market price SMS reporting and USSD lookup; content editor with draft → approved flow |
| **6** | 11–12 | Pilot-ready | Security review; load test (e.g. 10,000 SMS in one broadcast); backups and restore test; officer training guide; field test with 30–50 farmers; fix list closed |

**MVP exit criteria (go or no-go for the pilot)**
- [ ] 30+ test farmers registered over USSD without help, with 80%+ completing registration
- [ ] A pest report reaches the officer dashboard in under 1 minute
- [ ] SMS delivery rate ≥ 95% on the test group
- [ ] All advisories in production are approved by an agronomist
- [ ] Restore from backup tested
- [ ] Officers trained and able to answer and broadcast on their own

---

## Phase 3: Pilot (6 months, Bong and Nimba)

| Month | Focus |
|---|---|
| 1 | Sign the agreements: MOA (officers and content approval), telco (short code, zero-rating), co-ops. Train officers and lead farmers. |
| 2 | Launch in 2 districts. Assisted registration at co-op meetings. Weekly check-ins with officers. |
| 3 | Expand to all pilot districts. Add **voice advice** in Kpelle and Liberian English. |
| 4 | Mid-pilot review: metrics, farmer interviews, fix the top 5 problems. Add cocoa and vegetable content. |
| 5 | Market prices with trained reporters in 3 markets. "Did it help?" surveys. |
| 6 | Harvest survey (yield and income), pilot report, scale plan and funding proposal. |

**Pilot targets** (agree them with partners): [__] registered farmers · [__]% monthly active · [__]% questions answered within 24 h · [__]% "advice helped" · opt-out rate below [__]%.

---

## Phase 4: Scale (after the pilot)
- Roll out county by county with MOA extension. Train a "county champion" officer in each.
- Add languages (Bassa, Kissi, Gio, Mano, Grebo…) and crops (oil palm, rubber, vegetables).
- Photo diagnosis model: collect labelled photos during the pilot, train, and run on the phone. An officer still confirms.
- Partner features: agro-dealer listings, buyer and co-op market links, input credit and insurance through partners.
- Long-term ownership: MOA operates the platform, with costs shared by telco sponsorship and listing fees.

---

## Team and responsibilities

| Area | Lead role | Supports |
|---|---|---|
| Product decisions, partners, pitch | Team lead / PM | All |
| Farmer research, field tests, metrics | User researcher | Content lead |
| Figma, USSD wording, usability | UX/UI designer | Researcher |
| Farmer PWA, dashboard | Frontend developer | Designer |
| API, USSD/SMS gateway, scheduler, security | Backend developer | Frontend dev |
| Advisories, translations, agronomist review | Agri content lead | Extension officer partner |

## How we work
- **Board:** GitHub Projects with To do, In progress, Review and Done. One owner per issue.
- **Branches:** `main` is always demo-ready. Use feature branches and pull requests, with one review before merge.
- **Definition of done:** works on a low-end Android **and** over USSD/SMS where relevant; has basic tests; texts are 160 characters or fewer; reviewed; demo-able.
- **Testing:** unit tests for the advisory engine and hotspot rules; the USSD simulator (`prototype/ussd.html`) for flow checks; a real-phone test every sprint; a farmer test every sprint.
- **Rhythm:** a 15-minute check-in on WhatsApp each day, and a demo and retrospective each sprint.

## Budget headings (fill with real quotes)
SMS and USSD traffic · voice minutes · hosting · phones for testing · translation and audio recording · field travel for registration and training · officer airtime and data.

## Build progress

| Step | What | Status |
|---|---|---|
| 1 | Foundation: API, database, content files, advisory engine, pest diagnosis, tests, CI (`services/api`, `content/`) | ✅ Done, see [dev-setup.md](dev-setup.md) |
| 2 | USSD `*347#` and SMS: register, advice, report pest, ask expert, profile; SMS keywords HELP/ASK/STOP/START; simulator connected live | ✅ Done |
| 3 | Officer dashboard connected: live reports with verify/reject, automatic hotspots, answer questions by SMS, broadcast by county and crop | ✅ Done |
| 4 | Daily crop advice job (new stage, 28-day reminders, 3/week cap), SMS queue with retries and delivery reports, Africa's Talking and generic HTTP providers, webhook secret | ✅ Done |
| 5 | Farmer app (`apps/farmer`): SMS-code sign-in, registration, advice, county alerts, Pest Doctor and questions that work offline and sync without duplicates | ✅ Done |
| 6 | Weather (Open-Meteo per county, farm advice, rain alerts) and market prices (SMS reporting, unusual-price check, weekly change) on USSD, SMS, app and dashboard | ✅ Done |

**All six build steps are done: the hackathon MVP is complete.**

### Phase 2 · Sprint 1 progress

| # | Work | Status |
|---|---|---|
| 2.1 | Staff accounts: personal logins, roles (admin / officer / editor / viewer), officers limited to their counties, 2-step login (TOTP), lockout after 5 wrong tries, 12-hour sessions, audit log, admin tools, `create-admin` script; replaces `OFFICER_TOKEN` | ✅ Done |
| 2.2 | Deployment: Docker image (non-root, health check), Caddy with automatic HTTPS, daily checked backups + restore script, system status page, error log + webhook alerts, security headers, per-IP login limits, clean shutdown, production safety checks, CI builds the image. Guide: [deploy.md](deploy.md) | ✅ Done |
| 2.3 | PostgreSQL: one async database layer for SQLite and PostgreSQL, numbered migrations, PostgreSQL in Docker Compose, backups and restore for both, `sqlite-to-postgres` move script; all tests run on both databases in CI | ✅ Done |
| 2.4 | Real-phone test with an SMS provider on Lonestar Cell MTN and Orange | Next: needs an SMS account |

## Next 7 days
1. Turn every **Must** story in [backlog.md](backlog.md) into a GitHub issue with an owner.
2. Decide the stack (0.3) and set up the repo folders (0.6).
3. Get an agronomist to review the rice and cassava content (0.5).
4. Test the USSD wording in `prototype/ussd.html` with two farmers by phone.
5. Contact a telco or aggregator about a sandbox and a short code (0.4).
