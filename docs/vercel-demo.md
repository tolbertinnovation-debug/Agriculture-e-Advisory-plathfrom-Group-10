# Put the AgriConnect demo on Vercel (free)

This puts a **view-only demo** online for partners, judges and the team: the farmer app mock-up, the officer dashboard with sample data, and the `*347#` USSD simulator. It takes about 10 minutes and costs nothing on Vercel's free Hobby plan.

**What the demo is not:** it has no server behind it. Nothing is saved, no SMS is sent, and real phones can't dial in. All numbers are sample data. The real platform (`services/api`) needs an always-on server; see [deploy.md](deploy.md). Move to that when the SMS provider is ready.

## Steps
1. Go to [vercel.com](https://vercel.com) and **sign up with GitHub** (free Hobby plan).
2. Click **Add New… → Project**, find **Agriculture-e-Advisory-plathfrom-Group-10** and click **Import**. If the repository isn't listed, click *Adjust GitHub App Permissions* and give Vercel access to it.
3. On the *Configure Project* screen:
   - **Root Directory:** click *Edit* and choose **`prototype`**. This is the important step.
   - **Framework Preset:** **Other**.
   - **Build Command** and **Output Directory:** leave empty. There is nothing to build.
   - **Environment Variables:** none.
4. Click **Deploy**. After about a minute you get an address like `https://agriculture-e-advisory-….vercel.app`.
5. Open it: the start page links to the three demos.

Every push to `main` updates the demo by itself. Pushes to other branches get their own preview address.

## What's included
| Address | What it shows |
|---|---|
| `/` (the start page, `demo.html`) | What AgriConnect is, with links to the three demos |
| `/index.html` | Farmer app mock-up: home, crop guide, Pest Doctor (try `?demo=diagnosis`), prices, Ask an Expert, weather, agro-dealers |
| `/dashboard.html` | Officer dashboard with sample data. Staff and Advice content are hidden, because they need the server |
| `/ussd.html` | Basic-phone simulator with offline menus: type `*347#` and press SEND |

`prototype/vercel.json` sends `/` to the start page and adds the same security headers as the real server.

## Good to know
- **The GitHub link** at the bottom of the start page only works for visitors if the repository is public.
- **The free Hobby plan is for non-commercial use.** A demo for a hackathon and partners fits that. A paid service for the Ministry would not.
- **To rename the address,** go to *Project → Settings → Domains* and pick a free `….vercel.app` name, for example `agriconnect-liberia.vercel.app`, if it's available.
- **Later:** when the real server is running, keep this demo for presentations, or point a domain at the real server instead.
