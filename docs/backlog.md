# AgriConnect Liberia: Product Backlog

User stories, grouped by epic. **Priority:** M = Must (hackathon MVP), S = Should (pilot), C = Could (scale).
**Size:** S (≤1 day), M (2–3 days), L (1 week+). Turn each Must story into a GitHub issue.

## E1 · Registration and profile
| ID | Story | Acceptance criteria | Pri | Size |
|---|---|---|:-:|:-:|
| E1.1 | As a farmer with a basic phone, I register over USSD so I get advice for my crops | Language → county → district → crops → planting month → consent; ≤6 screens; welcome SMS sent | M | M |
| E1.2 | As a farmer, I register in the app | Same fields; works offline and syncs later | M | S |
| E1.3 | As a lead farmer, I register other farmers | Farmer confirms by SMS reply `YES`; `registered_by` saved | S | M |
| E1.4 | As a farmer, I change my crops, language or county, or stop messages | USSD menu 6; `STOP` keyword works | M | S |

## E2 · Seasonal advice
| ID | Story | Acceptance criteria | Pri | Size |
|---|---|---|:-:|:-:|
| E2.1 | As a farmer, I get the right advice for my crop stage each week | Daily job matches stage by planting month; ≤3 pushes per week | M | M |
| E2.2 | As a farmer, I check this week's advice over USSD or the app | USSD menu 1; "Get by SMS" option | M | S |
| E2.3 | As a farmer, I don't get spraying advice when heavy rain is coming | Rain ≥70% suppresses spraying and fertilizer advice and sends a "wait" message | S | M |
| E2.4 | As a farmer who doesn't read, I listen to the advice | Audio per advisory; IVR number; app play button | S | L |

## E3 · Pest Doctor and outbreaks
| ID | Story | Acceptance criteria | Pri | Size |
|---|---|---|:-:|:-:|
| E3.1 | As a farmer, I report a pest by choosing symptoms | USSD menu 4 and app; reply with likely pest + 3 steps + reference number | M | M |
| E3.2 | As a farmer, I add a photo in the app | Photo compressed to ≤300 KB; queued offline | S | M |
| E3.3 | As an officer, I see and verify pest reports in my counties | List with filters; confirm or correct the pest; farmer notified | M | M |
| E3.4 | As an officer, I see hotspots automatically | ≥3 reports, same pest and district, within 7 days → flagged | M | S |
| E3.5 | As a farmer, I'm asked if the advice helped | Follow-up SMS after 7 days; answers recorded | S | S |
| E3.6 | As a farmer, I get a photo-based suggestion | On-device model; officer confirms | C | L |

## E4 · Ask an Expert
| ID | Story | Acceptance criteria | Pri | Size |
|---|---|---|:-:|:-:|
| E4.1 | As a farmer, I ask a question by app, SMS (`ASK …`) or a USSD call-back request | Appears in the officer queue for my district | M | M |
| E4.2 | As an officer, I answer and the farmer gets it on their channel | Answer sent by SMS or app; status set to Answered | M | S |
| E4.3 | As an officer, unanswered questions escalate | After 24 h, reassigned to a backup officer | S | S |
| E4.4 | As an editor, I turn common answers into FAQs | "Save as advisory" button → draft | S | S |

## E5 · Officer dashboard and broadcasts
| ID | Story | Acceptance criteria | Pri | Size |
|---|---|---|:-:|:-:|
| E5.1 | As an officer, I log in and see only my counties | Role-based access; 2FA for staff | M | M |
| E5.2 | As an officer, I send an advisory to selected counties, crops and channels | Shows reach before sending; delivery report after | M | M |
| E5.3 | As MOA, I see county-level reports | Registered, active, reports, response times; CSV export | S | M |

## E6 · Weather and prices
| ID | Story | Acceptance criteria | Pri | Size |
|---|---|---|:-:|:-:|
| E6.1 | As a farmer, I see a 3–5 day forecast for my county with an action | USSD menu 2; app weather screen | S | M |
| E6.2 | As a market reporter, I send prices by SMS | `PRICE GBARNGA RICE 45` parsed and saved; reporter verified | S | M |
| E6.3 | As a farmer, I check prices and set an alert | USSD menu 3; app alert by threshold | S | M |

## E7 · Content management
| ID | Story | Acceptance criteria | Pri | Size |
|---|---|---|:-:|:-:|
| E7.1 | As a content lead, I load advisories from `content/` files | Validated JSON/YAML; errors reported | M | S |
| E7.2 | As an editor, I write, translate and approve advisories in the dashboard | Draft → Review → Approved; approver shown | S | L |
| E7.3 | As an editor, I upload audio per language | MP3/OGG ≤1 MB; linked to the advisory | S | S |

## E8 · Platform and quality
| ID | Story | Acceptance criteria | Pri | Size |
|---|---|---|:-:|:-:|
| E8.1 | CI runs tests on every push | Engine and hotspot rules covered | M | S |
| E8.2 | Staging and production servers with daily backups | Restore tested | S | M |
| E8.3 | Message log and cost tracking | Per channel, per county, per month | S | M |
| E8.4 | Monitoring and alerts | Uptime, errors and SMS delivery rate | S | S |
