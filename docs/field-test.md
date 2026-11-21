# Field test plan: 30–50 farmers, 4 weeks

This is the last step of the MVP (Sprint 6 in [build-plan.md](build-plan.md)). Real farmers in **Bong and Nimba** use AgriConnect for 4 weeks. At the end we decide **go or no-go for the 6-month pilot**, using the exit criteria below.

## Before day 1 (the week before)
| # | Task | Who | Done when |
|---|---|---|---|
| 1 | Server set up as in [deploy.md](deploy.md); `npm run preflight` shows **READY** | Backend dev | Screenshot of the Pilot readiness card |
| 2 | SMS/USSD provider live on Lonestar Cell MTN and Orange; `*347#` (or the provider's test code) works on team phones | Backend dev | 5 team phones registered and got advice |
| 3 | All English advice approved by a CARI/MOA agronomist in *Advice content* | Content lead | The *Field test* card shows "16 of 16" |
| 4 | Officers trained with [officer-guide.md](officer-guide.md), and all practice tasks done | Team lead | Each officer ticked the practice list |
| 5 | One lead farmer per community trained to register farmers | Officers | Lead farmer accounts made, each registered one test farmer |
| 6 | Farmers chosen: 30–50, mixed by county, gender, age, basic phone vs smartphone, and reading level | Researcher | List with consent to take part |
| 7 | A restore drill passed in the last week | Backend dev | *System status* shows it |

## The 4 weeks
| Week | What happens | Watch on the dashboard |
|---|---|---|
| 1 | **Joining.** Half of the farmers register themselves on `*347#` with no help (we only watch); the other half are registered by a lead farmer and reply YES | *Field test* → sign-up completion and where people stop |
| 2 | **Advice and pests.** Farmers get crop-stage SMS. We ask each farmer to report one real or practice pest problem | Pest reports reach the dashboard in **under 1 minute** (time it with 3 farmers) |
| 3 | **Questions.** Each farmer asks one question (SMS `ASK`, `*347#` → 5, or the app with a photo) | Questions answered within 24 h; "Over 24h" count |
| 4 | **Advisory and feedback.** Officers send one real advisory by county. Then a 10-minute phone interview with every farmer | SMS delivered %; "Did it help?" answers |

**Every day:** a 15-minute check-in on WhatsApp. Any problem goes on the **fix list** (below) the same day.

## Exit criteria: go or no-go for the pilot
| Criterion | Where to read it | Target |
|---|---|---|
| Farmers registered over USSD without help | *Field test* card (registered on `*347#`) and the CSV (`joined_via = ussd`) | 30 or more |
| Of those who start on `*347#`, how many finish | *Field test* → "Finish signing up on \*347#" | **80% or more** |
| A pest report reaches the officer dashboard | Timed by the researcher, 3 tries | **under 1 minute** |
| SMS delivered | Each advisory's delivery line; *Pilot readiness* → "SMS delivered" | **95% or more** |
| All advice in use approved by an agronomist | *Field test* → "Advice approved by an agronomist" | **all** |
| A restore from backup was tested | *System status* → Restore drill | passed in the last 30 days |
| Officers answer and send advisories on their own | Observed in week 3–4; audit log | every officer, without help |

**Go** if every criterion is met. If one is missed, fix it, then repeat that week with 10 farmers.

## Interview questions (week 4, 10 minutes, in the farmer's language)
1. Which advice SMS did you act on? What did you do?
2. Was anything hard on `*347#`? Where did you get stuck?
3. Did the pest advice help? (Compare with their 1/2 answer.)
4. Was the language right? Would you prefer Kpelle, Bassa or Kissi, or voice messages?
5. Did you get too many SMS, too few, or the right number?
6. Would you tell a friend to join? Why or why not?

## Fix list
Keep it in a shared sheet; every item has an owner and is closed before the pilot.

| # | Date | Found by | What happened (farmer phone, screen, time) | How bad (blocks / annoys / idea) | Owner | Fixed in | Closed |
|---|---|---|---|---|---|---|---|
| 1 | | | | | | | |

## What to download at the end
- **Farmers CSV** (*Farmers* → Download CSV): one row per farmer, with SMS sent, delivered and failed, reports, questions, and last contact.
- **Screenshot of the *Field test* card**, and the **Pilot readiness** list.
- **The fix list** and the interview notes. These go into the pilot report.
