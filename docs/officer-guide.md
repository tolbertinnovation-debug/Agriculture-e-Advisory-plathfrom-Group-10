# AgriConnect: guide for extension officers

This guide is for the officers, lead farmers and agronomists who will use AgriConnect in the pilot. Training takes about **2 hours**: read each part together, then do the practice tasks on the demo server. Officers are ready when they can do all of the practice tasks in the box at the end without help.

---

## 1. What AgriConnect does for farmers
- Farmers dial **\*347#** on any phone, free. They can register, get crop advice, see the weather and market prices, report a pest, and ask an expert.
- They also get **SMS advice** for each stage of their crop (rice, cassava), on the day it is due, at most 3 a week.
- With a smartphone, they can use the **farmer app**, which also works offline.
- They can always reply **STOP** to stop SMS, and **START** to get them again. That is their right: never sign someone up without their YES.

**Your job:** answer farmers' questions, check pest reports, warn farmers when a pest spreads, and help farmers join.

---

## 2. Logging in
1. Open the dashboard address you were given (for example `https://agriconnect.moa.gov.lr/prototype/dashboard.html`).
2. Enter **your own** email and password. Never share an account: everything you do is recorded with your name.
3. **The first time, set up 2-step login** (*Staff & security* → *Set up 2-step login*):
   - install an authenticator app (Google Authenticator or Microsoft Authenticator) on your phone;
   - add the key shown on the screen, then type the 6-digit code.

   From then on, you log in with your password **and** the code from your phone.
4. **Add your phone number for alerts** (*Staff & security* → *My phone for alerts*). You get an SMS when a pest hotspot appears in your counties.
5. Wrong password 5 times locks the account for 15 minutes. Forgot your password? Ask your admin to reset it.

You only see farmers, reports and questions from **your own counties**.

---

## 3. Your daily routine (about 30 minutes)

**Every morning:**

1. **Farmer questions** (the *Farmer questions* card)
   - Tick **Mine only** to see the questions assigned to you. Questions go first to the officer for the farmer's district, then to the least busy officer in the county.
   - Questions marked **Over 24h** are at the top: answer these first. After 24 hours the farmer was told *"we have not forgotten you"*, and your supervisors got an SMS.
   - **Text question:** type the answer (one SMS, max 139 characters) and press **Send**. The farmer gets it by SMS.
   - **Photo question:** click the photo to see it full size.
   - **📞 Wants a call-back:** call the farmer (free for them), then press **Mark as called**.
   - Another officer's question you can answer? Press **Take it**.
2. **Pest reports** (the *Pest reports* card)
   - Each report shows the likely pest that Pest Doctor guessed from the farmer's answers.
   - **Verify** if it is right. The farmer gets an SMS that an officer confirmed it.
   - **Reject** if it is clearly wrong. Rejected reports don't count towards hotspots.
   - If you visit or call and find a different pest, verify it with the correct pest.
3. **Hotspots** (the *Hotspots* card)
   - A hotspot means 3 or more reports of the same pest in one county within 7 days. The levels are **Watch** (3+), **Warning** (5+) and **Outbreak** (10+).
   - Press **Warn farmers** to write an advisory to that county (next section).

**Every week:**
- Look at the **Field test** card (next part).
- Check your **Invitations** list for farmers who haven't replied YES yet. Resend once, or call them.

---

## 4. Sending an advisory to many farmers
1. **Send an advisory** card: choose the **county** and the **crop** (or all crops).
2. Choose the channel:
   - **SMS** reaches every phone and costs money per SMS;
   - **App** shows it in the farmer app only, with no SMS cost.
3. Write **one SMS** (160 characters). Say what, where, and what to do. For example: *"Fall armyworm seen in Nimba. Check your maize and rice this week. Pick worms in the morning. Dial \*347# option 4 to report."*
4. Check **"Will reach N farmers"**, then send.
5. Under **Recently sent** you see for each advisory how many SMS were **delivered** and how many **failed**.

Farmers who said STOP never get advisories.

---

## 5. Helping farmers join (officers and lead farmers)
1. **Register a farmer** card: enter the farmer's name, phone, county, district, language, crops and the month they plant.
2. Press **Send invitation**. The farmer gets an SMS: *"… registered you for free rice advice in Bong. Reply YES to join or NO to refuse."*
3. **They join only when they reply YES**, by SMS or on \*347#. That is their consent. Tell the farmer to expect the SMS and to reply YES.
4. Invitations expire after 7 days, and you can resend at most twice.

**Lead farmers** see only their own invitations. Farmers can also register themselves on \*347# → 1. Show them how; it takes about 2 minutes.

---

## 6. Looking after your farmers
- **Farmers** card:
  - search by name, district or part of the phone number;
  - filter by county, crop, or "Said STOP".
- Click a farmer to see **everything**: every SMS they got (and whether it arrived), their reports, questions, invitation, and any changes.
- **Correct details** if something is wrong: name, district, crops and planting month. Every change is recorded. You cannot change their phone number or their STOP choice.
- Farmers can change their own crops on \*347# → 6 → 2.
- **Download CSV** gives your farmer list in Excel or Google Sheets, for the field-test log.

---

## 7. The field test numbers (the Field test card)
| Number | What it means | Pilot target |
|---|---|---|
| **Finish signing up on \*347#** | Of the people who start registering on \*347#, how many finish. *Where people stopped* shows the hard screen. | 80% or more |
| **"Did it help?"** | 3 days after a pest report, the farmer gets *"Did our advice help? Reply 1 = Yes, 2 = No."* A **No** becomes a call-back request in your questions. | as high as possible |
| **Advice approved by an agronomist** | How many advice texts an agronomist has checked. | all of them |

---

## 8. For agronomists: approving advice texts
1. Open **📝 Advice content**.
2. **Drafts to review** shows texts written by editors.
   - **Approve** a draft if it is correct, clear and safe.
   - Otherwise write what to change and press **Reject**.
3. **Not reviewed yet** shows texts nobody has checked. Fix them with *Suggest a new text*, or press **Approve as written**.
4. You cannot approve your own draft: another agronomist must.
5. Choose a language (Kpelle, Bassa, Kissi) to review translations. Farmers get a translation only after it is approved; until then they get English.

---

## 9. Problems and who to call
| Problem | What to do |
|---|---|
| Locked out, or lost the phone with the authenticator app | Ask your admin to reset your password (this also resets 2-step login) |
| A farmer says they get no SMS | Open the farmer: are the SMS **failed**? Did they say STOP? Is the phone number right? Tell the admin if many fail |
| A farmer wants to stop | They reply STOP, or choose \*347# → 6 → 3. You can't do it for them |
| A wrong pest diagnosis | Verify the report with the correct pest. Tell the agronomist if the same mistake repeats, so Pest Doctor can be improved |
| The dashboard shows an error | Refresh. If it stays, tell the admin the time and what you clicked |

**Your admin:** ______________________  **Phone:** ______________

---

## Practice tasks (on the demo server)
Log in as `mulbah@agriconnect.test` / `demo-officer-2026`, and open the USSD simulator in a second tab.

- [ ] Set up 2-step login and add your alert phone
- [ ] On the simulator, report *worms eating leaves* on rice in Nimba from 3 different numbers, then find the hotspot
- [ ] Warn the farmers in Nimba by SMS, and see the SMS arrive on the simulator
- [ ] Verify one pest report and reject one
- [ ] Answer a text question, and close a call-back request
- [ ] Register a farmer with an invitation, then reply YES from the simulator
- [ ] Find that farmer, open their history, and change their planting month
- [ ] Download the CSV of your farmers
