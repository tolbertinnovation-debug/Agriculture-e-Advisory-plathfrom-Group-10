# AgriConnect Liberia — Platform Blueprint

One advisory engine. Every phone. Every county.

## 1. Users
| User | Device | Main needs |
|---|---|---|
| Smallholder farmer (primary) | Basic phone or low-end smartphone | Early warnings, simple steps, voice in local language, fair prices |
| Extension officer | Smartphone / laptop | Question queue, pest hotspot view, bulk advisories |
| Trader / agro-dealer | Basic or smartphone | Be found by farmers, post prices |
| MOA / CARI / partners | Laptop | Approve content, see county-level data |

## 2. Channels
| Channel | Who it serves | Notes |
|---|---|---|
| Smartphone app (PWA) | Lead farmers, youth | Offline-first; photos for Pest Doctor |
| USSD `*347#` (placeholder) | Most rural farmers | No data needed; menu-based |
| SMS | All registered farmers | Push alerts by county & crop |
| Voice / IVR + call-back | Farmers who don't read | Recorded tips in Kpelle, Bassa, Kissi, etc. |
| Community radio scripts | Whole communities | Weekly scripts generated from the same content |
| Officer web dashboard | Extension officers, MOA | Q&A, outbreaks, broadcasts |

## 3. Features
1. **Crop calendar** — stage-by-stage advice per crop and county, with SMS reminders.
2. **Pest Doctor** — photo or symptom checker → likely pest/disease → low-cost steps first → one tap to an officer.
3. **Weather alerts** — 5-day county forecast translated into farm action.
4. **Market prices** — daily prices from Red Light, Gbarnga, Ganta, Voinjama, Buchanan; best place to sell; price-change alerts.
5. **Ask an Expert** — text, photo or voice question routed to the nearest officer; urgent cases get a call-back.
6. **Agro-dealer finder** — nearest certified seed, tools and inputs.
7. **Officer dashboard** — farmers by county/channel, pest hotspots, question queue, multi-channel advisory sender.
8. **Local languages** — Liberian English text + voice in local languages.

## 4. Architecture
```
 Channels:  App (PWA, offline) | USSD | SMS | Voice/IVR | Officer dashboard
                                   │
 Engine:    AgriConnect API + advisory engine
            (farmer profiles · rules by crop/county/season · diagnosis · alerts · Q&A routing)
                                   │
 Services:  Content library (text+audio) | Telco gateway (SMS/USSD/voice) | Photo model | Analytics
                                   │
 Data:      MOA & CARI guides | County weather feed | Market reporters | Farmer registry & co-ops
```
Suggested stack: PWA (HTML/JS + service worker), Node.js or Python (FastAPI) API, PostgreSQL, SMS/USSD aggregator connected to Lonestar Cell MTN and Orange Liberia, object storage for audio/photos.

### Core data model
- `Farmer` (id, name, phone, county, district, language, crops[], planting_dates, channel_pref)
- `Advisory` (id, crop, county, stage, text, audio_url, language, approved_by)
- `PestReport` (id, farmer_id, crop, symptoms[], photo_url, diagnosis, status, county, created_at)
- `Question` (id, farmer_id, text/audio/photo, assigned_officer, status, answer)
- `Price` (market, item, unit, price_lrd, date, reporter_id)
- `Broadcast` (id, counties[], crops[], channels[], message, sent_by, reach)

## 5. Roadmap
| Phase | Scope |
|---|---|
| 1 · Hackathon MVP | Farmer app (home, crop guide, Pest Doctor, ask expert, weather, prices), USSD simulator, officer dashboard, test with 5+ farmers |
| 2 · Pilot (6 months) | Bong & Nimba, [__] farmers via co-ops, live USSD/SMS with a telco, voice in Kpelle & Liberian English, MOA/CARI-approved content |
| 3 · Scale | All 15 counties, more languages & crops, photo diagnosis model, market linkage & input credit, hand-over to MOA extension |

## 6. Impact metrics (targets set with partners)
Monthly active farmers · % questions answered within 24 h · outbreaks caught early · change in yield/income · % women and youth reached.

## 7. Sustainability
Free for farmers. Funded by government/donor advisory programmes, paid listings for agro-dealers and buyers, and a telco partnership for zero-rated USSD/SMS.
