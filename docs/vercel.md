# Put AgriConnect on Vercel

This runs the **whole platform** on Vercel with a free **Neon** PostgreSQL database: the farmer app, the officer dashboard, the USSD and SMS webhooks, the content editor, and the staff pages. It takes about 20 minutes and nothing has to be installed on your computer.

## How it works on Vercel
Vercel runs AgriConnect only when a request comes in (it is "serverless"). There is no program running all the time, so the background work is done differently:

| Work | On a normal server | On Vercel |
|---|---|---|
| Sending queued SMS | Every 2 seconds | Right after each request (advisories, USSD, sign-in) |
| Approved advice texts, 24-hour escalation | Every minute | After requests, at most once a minute, and in the daily job |
| Crop advice, "Did it help?", weather, a restore drill | Daily jobs | One **daily job at 07:00 Liberia time** (Vercel Cron), protected by `CRON_SECRET` |
| Backups | Daily file in `BACKUP_DIR` | Kept by Neon. You also press **Download a backup** each week (Staff & security) |

The files: `vercel.json`, `api/index.js`, `services/api/src/serverless.js` and `services/api/scripts/vercel-build.js`.

## Steps

### 1. Create the project
1. Go to [vercel.com](https://vercel.com) and **sign up with GitHub**. The free Hobby plan is enough to start.
2. Click **Add New… → Project**, find **Agriculture-e-Advisory-plathfrom-Group-10** and click **Import**. If it isn't listed, click *Adjust GitHub App Permissions* and give Vercel access to it.
3. On *Configure Project*:
   - **Root Directory:** leave it as the repository root (`./`).
   - **Framework Preset:** **Other**.
   - **Build, Output and Install settings:** don't change them; `vercel.json` sets them.
4. Click **Deploy**. The first deploy works without a database. The pages are there, and the API says "not ready" until step 2 is done.

### 2. Add the database (Neon, free)
1. In the project, open **Storage → Create Database → Neon (Serverless Postgres)**.
2. Choose the region **Europe (London)**, the same as the functions (`lhr1` in `vercel.json`), and the free plan.
3. Connect it to the project for **all environments**. Vercel adds `DATABASE_URL` by itself.

### 3. Add the settings
In **Settings → Environment Variables**, add these for *Production*. Use long random values where it says secret, for example from a password manager.

| Name | Value | Why |
|---|---|---|
| `CRON_SECRET` | a long random secret (16+ characters) | Only Vercel may start the daily job |
| `DEMO_MODE` | `1` | **To show the features with sample data:** demo farmers, demo logins, sign-in codes on screen |
| *or, for real use:* `ADMIN_EMAIL`, `ADMIN_NAME`, `ADMIN_PASSWORD` | your email, your name, a password of 10+ characters | Creates the first admin on the next deploy. Delete `ADMIN_PASSWORD` afterwards |
| `REQUIRE_2FA` | `1` | For real use: every staff member must use 2-step login |

Then open **Deployments → ⋯ → Redeploy**, so the new settings take effect. During the build, the database is brought up to date and the demo data or the first admin is added.

### 4. Check it
- **The start address** opens the demo start page (in demo mode) or the farmer app.
- **`https://<your-project>.vercel.app/ready`** should show `"ok": true`.
- **The dashboard** is at `/prototype/dashboard.html`. Log in with a demo login from the start page, or with your admin account.
- **Settings → Cron Jobs** shows the daily job. On the Hobby plan it runs once a day, at some time within the hour.

### 5. Later: connect the SMS/USSD provider
Add `SMS_PROVIDER` (for example `africastalking`), the provider's keys (`AT_USERNAME`, `AT_API_KEY`, `AT_SENDER_ID`) and `WEBHOOK_SECRET`, then redeploy. Give the provider these addresses:
- `https://<your domain>/ussd?secret=<WEBHOOK_SECRET>`
- `https://<your domain>/sms/inbound?secret=<WEBHOOK_SECRET>`
- `https://<your domain>/sms/status?secret=<WEBHOOK_SECRET>`

**Demo mode must be off** before real farmers join: delete `DEMO_MODE`. The server refuses to start with demo mode and a real SMS provider. **Start real use with a new, empty database,** because the demo logins' passwords are public in the code. In Neon, create a new database and point `DATABASE_URL` at it, then set `ADMIN_*` and redeploy.

## Good to know before the pilot
- **Speed of USSD:** the first request after a quiet period is slower, because the function starts and Neon wakes up. Test `*347#` with the provider. If sessions time out, move to an always-on server ([deploy.md](deploy.md)); the code is the same.
- **SMS timing:** SMS go out right after requests and in the daily job, not on a timer. A question waiting over 24 hours is escalated as soon as anyone uses the system, or by the daily job at the latest.
- **Backups:** Neon keeps the database with a short restore window on the free plan. **Download a backup every week** from *Staff & security* and keep it in a safe place, such as Google Drive with limited sharing; it holds farmers' details.
- **The Hobby plan is for non-commercial use.** A hackathon demo and a field test fit that. A service run for the Ministry should move to Vercel Pro or its own server.
- **The readiness check** (*Staff & security → Pilot readiness*) shows what is still missing. It counts demo mode as blocking.
