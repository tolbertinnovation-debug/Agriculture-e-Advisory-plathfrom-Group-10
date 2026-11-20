# AgriConnect Liberia: Platform Blueprint (v2)

> **One advisory engine. Every phone. Every county.**
> AgriConnect gives Liberian smallholder farmers timely, local and trusted farming advice on any phone, in their language, even offline. It also gives extension officers the tools to reach thousands of farmers at once.

The build steps are in **[build-plan.md](build-plan.md)** and the user stories in **[backlog.md](backlog.md)**.

---

## 1. Problem and goal

| | |
|---|---|
| **User** | Smallholder farmers (rice, cassava, cocoa, oil palm, vegetables). Mostly rural, many with basic phones, many more comfortable speaking than reading. |
| **Pain** | Season-defining decisions (what and when to plant, when to spray, how to treat a sick crop, where to sell) are made without timely, local, trusted information. Extension officers are few and cover large areas. |
| **Goal (pilot)** | Within one season in two counties: [__] farmers active monthly, [__]% of questions answered within 24 h, outbreaks reported to officers within [__] days of first sighting, and a measurable change in yield or income. |
| **Non-goals (for now)** | Payments, loans, insurance and e-commerce. These come later, through partners. |

## 2. Design principles
1. **Basic phone first.** Every core feature must work over USSD, SMS or voice. The smartphone app is a richer version of the same thing, not the only way in.
2. **Voice before text.** Any advice we write also has a recorded audio version in at least one local language.
3. **Offline by default.** The app opens and shows the last advice with no network, and sends queued reports when the signal comes back.
4. **Short and actionable.** One message gives one action, in no more than 160 characters. Say what to do, not just what is wrong.
5. **Trusted content only.** Every advisory is written or approved by MOA, CARI or a certified extension officer, and shows who approved it.
6. **Low-cost remedies first.** Hand-picking, sanitation and local remedies come before purchased chemicals. Chemical advice always includes safety instructions.
7. **Free for farmers.** Farmers pay nothing for USSD, SMS or call-backs (zero-rated or sponsored).
8. **Consent and privacy.** Collect the minimum data, explain why we need it, and never sell farmer data.

## 3. Users and roles

| Role | Device | Can do |
|---|---|---|
| **Farmer** | Basic phone or smartphone | Register, get advice, report pests, ask questions, see prices |
| **Lead farmer / co-op agent** | Smartphone | Register farmers on their behalf (assisted sign-up), relay advice at meetings, report for others |
| **Extension officer** | Smartphone or laptop | Answer questions, verify pest reports, send advisories to their counties |
| **Content editor** (MOA / CARI) | Laptop | Write, translate, record and approve advisories |
| **Market reporter** | Basic phone or smartphone | Submit daily prices by SMS or app |
| **Agro-dealer** | Any phone | List the shop, stock and prices |
| **Admin / partner viewer** | Laptop | Manage users, view county reports (anonymised) |

## 4. Key user journeys

**A. Register (2 minutes, any phone)**
Dial `*347#`, then choose language, county, district, main crops and planting month. Confirm consent. A welcome SMS arrives and the first crop-stage advice follows the next morning.
*Assisted:* a lead farmer registers 20 farmers at a co-op meeting from the app; each farmer confirms by SMS.

**B. Pest outbreak (the core loop)**
1. A farmer sees worms in the maize funnel. They dial `*347#`, choose 4 (Report pest), then 1 (Worms eating leaves), or use Pest Doctor in the app with a photo.
2. They immediately get the likely cause, three low-cost steps and a reference number.
3. The report appears on the officer dashboard, grouped by district.
4. When three or more reports for the same pest arrive from one district within 7 days, a **hotspot** is flagged automatically.
5. The officer verifies it (by call or visit) and sends one advisory to every farmer growing that crop in the district, by SMS, voice and app.
6. Seven days later, a follow-up SMS asks "Did the advice help? 1 = Yes, 2 = No". The answers measure impact.

**C. Ask an expert**
The farmer sends a question by text, voice note or photo, or asks for a free call-back over USSD. It goes to an officer covering that district. Urgent or unanswered questions are escalated after 24 h to a backup officer. Good answers are saved to the content library as FAQs.

**D. Sell at a fair price**
A market reporter sends `PRICE GBARNGA RICE 45` by SMS each morning. A farmer checks prices over USSD or the app, or subscribes to an alert for when pepper goes above X LRD.

**E. Seasonal advice (push)**
The engine knows each farmer's crops, county and planting month, and sends the right stage advice on the right week. Weather rules override it when needed: "Heavy rain expected: don't apply fertilizer until Saturday."

## 5. Features and MVP scope

Scope rules: **M** = Must (hackathon MVP), **S** = Should (pilot), **C** = Could (scale).

| # | Feature | App | USSD | SMS | Voice | Officer | Scope |
|---|---|:-:|:-:|:-:|:-:|:-:|:-:|
| 1 | Registration and profile (crops, county, language, consent) | ✓ | ✓ | | | ✓ | **M** |
| 2 | Crop calendar and stage advice (rice, cassava, then cocoa and vegetables) | ✓ | ✓ | ✓ push | ✓ | edit | **M** |
| 3 | Pest Doctor: symptom checker plus report to officer | ✓ | ✓ | | | verify | **M** |
| 4 | Ask an Expert: question queue and call-back request | ✓ | ✓ | ✓ reply | | answer | **M** |
| 5 | Officer dashboard: queue, reports, hotspots, broadcast | | | | | ✓ | **M** |
| 6 | Weather alerts with farm advice (county level) | ✓ | ✓ | ✓ push | | | **S** |
| 7 | Market prices and price alerts | ✓ | ✓ | ✓ | | | **S** |
| 8 | Voice advice in Kpelle, Bassa and Liberian English (IVR) | ✓ play | | | ✓ | record | **S** |
| 9 | Impact follow-up surveys ("Did it help?") | | | ✓ | | report | **S** |
| 10 | Photo diagnosis model (on-device, works offline) | ✓ | | | | review | **C** |
| 11 | Agro-dealer finder and listings | ✓ | ✓ | | | | **C** |
| 12 | Community radio scripts generated from weekly advice | | | | | export | **C** |
| 13 | Market linkage (buyers ↔ co-ops), input credit via partners | ✓ | | | | | **C** |

## 6. Channel design rules

**USSD**
- Keep each screen under about 160 characters and show no more than 6 options.
- Use `0` for Back and `00` for Main menu on every screen.
- Sessions time out after a few minutes, so any flow should take 5 screens or fewer.
- Anything long, such as full advice, is sent by follow-up SMS ("1. Get by SMS").

USSD menu tree (MVP):
```
*347#
├─ 1 Crop advice ─ choose crop ─ this week's advice ─ [1 Get by SMS]
├─ 2 Weather ─ 3-day county forecast + action
├─ 3 Market prices ─ choose market ─ top 5 prices
├─ 4 Report pest ─ choose symptom ─ choose crop ─ confirm → ref no. + 3 steps by SMS
├─ 5 Ask an expert ─ 1 Call-back / 2 Voice message
└─ 6 My profile ─ crops / county / language / stop messages
```

**SMS**
- Push alerts are capped at about 3 per week per farmer to avoid fatigue (urgent pest alerts are exempt).
- Every message ends with the help code: `Dial *347# for help`.
- Keywords: `STOP`, `HELP`, `PRICE <market> <item>`, `ASK <question>`.

**Voice / IVR**
- A toll-free number plays the advice of the week in the chosen language.
- Pressing 9 leaves a voice question, which arrives in the officer queue as audio.
- Officer call-backs are logged with the outcome.

**Smartphone app (PWA)**
- Under 1 MB on first load, and it works on Android Go phones.
- The service worker caches the shell and the last 4 weeks of advice.
- Reports and questions are queued in IndexedDB and synced in the background.

## 7. Advisory engine: how advice is chosen
Advice is **rule-based, not AI-generated**, for safety and trust. Each advisory carries targeting tags:

```
Advisory { crop: rice, stage: weeding, county: [Bong, Lofa], weeks_after_planting: 3,
           weather_condition: none, language: [en-LR, kpe], channel_text, audio_url,
           approved_by: CARI, valid_until }
```

Daily job:
1. For every farmer, compute the stage from crop and planting month.
2. Find matching advisories.
3. Apply weather overrides, such as not advising spraying when rain is ≥ 70%.
4. Respect the message cap and language.
5. Queue messages per channel.

The **Pest Doctor** in the MVP is a symptom-scoring table maintained by content editors. In phase C, a lightweight image model (trained on public crop-disease datasets plus photos collected and labelled during the pilot) gives a *suggestion*, and an officer still confirms it.

## 8. Architecture

```
 CHANNELS   Farmer PWA  |  USSD  |  SMS  |  Voice/IVR  |  Officer & editor web app
                  \        \       |       /              /
 GATEWAY           Telco aggregator (SMS/USSD/voice callbacks → webhooks)
                                   │
 CORE       AgriConnect API (REST, JSON)
            ├─ Auth & roles (phone + OTP for farmers; email + password + 2FA for staff)
            ├─ Farmers & consent      ├─ Advisory engine & scheduler
            ├─ Pest reports & hotspots├─ Questions & routing
            ├─ Prices                 └─ Broadcasts & message queue
                                   │
 DATA       PostgreSQL (+PostGIS for districts)  |  Redis queue  |  Object storage (audio, photos)
                                   │
 PARTNERS   MOA/CARI content  |  Weather API  |  Market reporters  |  Co-op registries
```

### Recommended tech stack (simple, cheap, easy to hire for in Liberia)

| Layer | Choice | Why |
|---|---|---|
| Farmer app | PWA with plain JS or React + Vite, Workbox service worker | Small, installable, offline, no app-store needed |
| Officer dashboard | React + a simple component library | Same skills as the app |
| API | Node.js (Express or NestJS) **or** Python (FastAPI). Pick the one the team knows best | Quick to build, many tutorials |
| Database | PostgreSQL + PostGIS | Reliable; maps districts and hotspots |
| Jobs and queue | Redis + BullMQ (Node) or Celery/RQ (Python) | Scheduled advice, SMS retries |
| SMS / USSD / voice | An aggregator that covers Liberia, or direct integration with Lonestar Cell MTN and Orange Liberia | One API for all telco channels |
| Hosting | One small cloud VM or a managed platform; daily database backups | Low cost to start |
| Monitoring | Uptime check + error tracking + SMS delivery-rate dashboard | Know when messages fail |

### Core API (MVP)
```
POST /ussd/callback                 USSD session handler (telco webhook)
POST /sms/inbound                   SMS keywords & replies
POST /farmers                       register (app / assisted)
GET  /farmers/{id}/advice           this week's advice
POST /pest-reports                  create report (app, USSD)
GET  /pest-reports?county=&status=  officer list
GET  /hotspots                      auto-flagged clusters
POST /questions        PATCH /questions/{id}   ask / answer
GET  /prices?market=   POST /prices            read / report prices
POST /broadcasts                    officer advisory to counties, crops, channels
GET  /advisories       POST /advisories        content library (editor, approval flow)
```

### Data model
- **Farmer**: id, phone (hashed for analytics), name, county, district, language, crops[{crop, planting_month}], channels, consent_at, registered_by
- **Advisory**: id, crop, stage, counties[], conditions, text{lang}, audio{lang}, status (draft/approved), approved_by, valid_until
- **PestReport**: id, farmer_id, crop, symptoms[], photo_url, suggested_pest, confirmed_pest, district, status, created_at
- **Hotspot**: pest, district, report_count, first_seen, status (flagged/verified/closed)
- **Question**: id, farmer_id, channel, text/audio/photo, district, assigned_officer, status, answer, answered_at
- **Price**: market, item, unit, price_lrd, reporter_id, date, verified
- **Broadcast**: id, filters{counties, crops}, channels[], message, sent_by, reach, delivered
- **MessageLog**: id, farmer_id, channel, template, status, cost, sent_at
- **User (staff)**: id, role, counties[], name, contact

## 9. Content plan
- **Start small and accurate:** 2 crops (rice, cassava) × 6 stages × 2 languages, plus the 6 most common pests and diseases.
- Write with a CARI or MOA agronomist, test the wording with farmers, then record the audio with a native speaker.
- **Editorial flow:** Draft → Agronomist review → Translation and recording → Approved → Published. Every advisory has an expiry date and is reviewed each season.
- Officer answers that come up again and again become FAQ advisories.

## 10. Trust, safety and data protection
- **Consent** is recorded at registration, in the farmer's language. `STOP` unsubscribes at any time.
- **Data minimisation:** we store phone, location to district level, crops and language. We never store national ID or GPS of homes in the MVP.
- **Security:** HTTPS everywhere; staff accounts use 2FA; role-based access (officers see only their counties); encrypted backups.
- **Sharing:** partners see only anonymised, county-level reports. Farmer-level data is never sold.
- **Compliance:** follow Liberian law and Liberia Telecommunications Authority (LTA) rules for short codes and bulk SMS. Get legal advice before the pilot.
- **Chemical safety:** pesticide advice names only approved products and always includes protective steps.

## 11. Partners needed

| Partner | What they give | What they get |
|---|---|---|
| Ministry of Agriculture (MOA) | Extension officers, content approval, endorsement | Reach and data on farmers and outbreaks |
| CARI | Agronomy content, seed information | Faster spread of research |
| Telco(s) | Short code, zero-rated USSD/SMS | Rural subscribers, social impact |
| Farmer co-ops / NGOs | Assisted registration, trust | Service for members |
| Donor / development programme | Pilot funding | Measurable impact |
| Agro-dealers and buyers | Listings fees (later) | Customers |

## 12. Success metrics

| Area | Metric |
|---|---|
| Reach | Registered farmers; % women; % youth; % on basic phones |
| Engagement | Monthly active farmers; USSD sessions per farmer; SMS opt-out rate |
| Service | % questions answered < 24 h; officer response time; SMS delivery rate |
| Outcomes | Outbreaks verified within X days; "Did it help?" yes-rate; self-reported yield/income change at harvest |
| Cost | Cost per farmer reached per month |

## 13. Risks and how we reduce them

| Risk | Mitigation |
|---|---|
| Telco short code and zero-rating take months | Start talks now; meanwhile use a long-number SMS and a USSD sandbox; budget for SMS costs |
| Wrong or unsafe advice | Only approved content; rule-based engine; officer confirms every diagnosis |
| Farmers don't trust a "phone service" | Launch through co-ops and officers they know; show the approver's name; voice in local languages |
| Officers overloaded by questions | FAQ auto-replies, routing by district, backup officers, lead farmers triage |
| Low literacy | Voice, icons and numbers in USSD; assisted registration |
| Message fatigue leading to opt-outs | Cap at 3 pushes a week; only relevant crops and county |
| Network and power outages | Offline app; SMS retries; USSD fallback |
| Funding ends after the pilot | MOA ownership plan, dealer listings and a telco partnership from day one |

## 14. Cost drivers (fill with real quotes)

| Item | Unit | Estimate |
|---|---|---|
| SMS (outbound) | per message | [LRD/USD __] |
| USSD session | per session | [__] |
| Voice / IVR | per minute | [__] |
| Hosting | per month | [__] |
| Audio recording and translation | per advisory | [__] |
| Field team (registration, training) | per county | [__] |
