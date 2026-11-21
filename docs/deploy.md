# Deploying AgriConnect on a server

This guide puts AgriConnect online at an HTTPS address such as `https://agriconnect.example.org`, with daily checked backups. It takes about an hour the first time. Everything runs in Docker: the app, its **PostgreSQL** database, and **Caddy**, which gets and renews the HTTPS certificate for free.

```
Internet ──► Caddy (ports 80/443, HTTPS) ──► AgriConnect app (port 3000, inside Docker)
                                                 ├─ PostgreSQL 16 → Docker volume "postgres-data" (not reachable from the internet)
                                                 └─ backups       → deploy/backups/ on the server
```

## What you need
- **A server** (a "VPS") with Ubuntu 22.04 or 24.04, 1–2 GB RAM and 25 GB disk. Any cloud provider works. Choose one with a data centre close to West Africa for speed.
- **A domain name** you control, e.g. `agriconnect.example.org`.
- **SSH access** to the server, and someone comfortable typing commands.

## 1. Prepare the server (once)
```bash
# Log in to the server
ssh you@your-server-ip

# Install Docker (official script) and git
curl -fsSL https://get.docker.com | sudo sh
sudo apt-get install -y git
sudo usermod -aG docker $USER   # then log out and back in

# Firewall: only SSH, HTTP and HTTPS
sudo ufw allow OpenSSH && sudo ufw allow 80 && sudo ufw allow 443 && sudo ufw enable
```

## 2. Point the domain at the server
At your domain registrar, add a DNS **A record**: `agriconnect.example.org → your-server-ip`. Wait until `ping agriconnect.example.org` shows the server's IP; this can take up to an hour.

## 3. Get the code and fill in the settings
```bash
git clone https://github.com/tolbertinnovation-debug/Agriculture-e-Advisory-plathfrom-Group-10.git agriconnect
cd agriconnect/deploy
cp .env.example .env
nano .env          # set DOMAIN, POSTGRES_PASSWORD, WEBHOOK_SECRET and the SMS settings when you have them
mkdir -p backups && sudo chown 1000:1000 backups   # the app runs as user 1000 inside Docker
```
To make a random secret or password: `openssl rand -hex 24` (use it for `POSTGRES_PASSWORD` and `WEBHOOK_SECRET`; letters and digits only).

**Never commit `.env` to GitHub.** It holds your keys.

## 4. Start it
```bash
docker compose up -d --build
docker compose ps            # "db" and "api" should become (healthy)
docker compose logs -f api   # Ctrl+C to stop watching
```
Open `https://agriconnect.example.org/health`. You should see `{"ok":true,...}` with a padlock in the browser.

## 5. Create the first admin
```bash
docker compose exec api npm run create-admin -- you@example.org "Your Name"
```
The password is printed **once**. Then:
1. Open `https://agriconnect.example.org/prototype/dashboard.html` and log in.
2. Because `REQUIRE_2FA=1`, you are sent to **Staff & security** to set up 2-step login with an authenticator app.
3. Change your password.
4. Create accounts for the other officers (each officer gets only their counties).

**Never run `npm run seed` on the server.** It adds demo farmers and public demo passwords. It refuses to run when `NODE_ENV=production`.

## 6. Connect the SMS / USSD provider (when you have an account)
In `.env`, set `SMS_PROVIDER` and its keys (see `docs/dev-setup.md`, section 6). Then run `docker compose up -d`. In the provider's dashboard, set these URLs, each ending in your `WEBHOOK_SECRET`:

| Provider setting | URL |
|---|---|
| USSD callback (`*347#`) | `https://agriconnect.example.org/ussd?secret=…` |
| Incoming SMS | `https://agriconnect.example.org/sms/inbound?secret=…` |
| Delivery reports | `https://agriconnect.example.org/sms/status?secret=…` |

The server **refuses to start** if a real SMS provider is set without `WEBHOOK_SECRET`.

Test with the team's own phones on **both** Lonestar Cell MTN and Orange before any farmer is told about the service.

## 7. Backups
- **Automatic:** every day at `BACKUP_HOUR` (02:00 Liberia time) the app writes every row of every table to `agriconnect-YYYYMMDD-HHMMSS.jsonl.gz` in `deploy/backups/`. It is read back and its row counts are checked right after it is made. The newest `BACKUP_KEEP` (14) are kept.
- **Extra safety (optional):** PostgreSQL's own dump as well: `docker compose exec db pg_dump -U agriconnect -Fc agriconnect > backups/pg-$(date +%F).dump`.
- **By hand:** dashboard → Staff & security → System status → **Back up now**, or `docker compose exec api npm run backup`.
- **Off-site copy (do this!):** a backup on the same server is lost if the server is. Copy `deploy/backups/` somewhere else every day, e.g. with a cron job to another machine or cloud storage:
  ```bash
  # example: every day at 03:00 copy backups to another server
  0 3 * * * rsync -a ~/agriconnect/deploy/backups/ backup-user@other-server:agriconnect-backups/
  ```

### Restore drill (once a month, and after every upgrade)
The safe drill never touches the live data: it restores the newest backup into a separate, empty database and checks every table.
```bash
docker compose exec api npm run restore-drill
```
Or click **Run restore drill** on *Staff & security* → *System status*. The result is shown there; the status warns if no drill passed in the last 30 days.

### A real restore (when data has been lost)
```bash
cd ~/agriconnect/deploy
docker compose stop api
docker compose run --rm api npm run restore -- /backups/agriconnect-YYYYMMDD-HHMMSS.jsonl.gz --yes
docker compose start api
```
The restore checks the backup first and replaces all rows in **one transaction**: if anything goes wrong, nothing changes. Make a fresh backup before restoring, so a restore can be undone.

### Moving from a SQLite server (e.g. the hackathon demo) to PostgreSQL
If you already ran AgriConnect with SQLite and want to keep its data, copy the `.db` file onto the new server, then:
```bash
docker compose cp agriconnect.db api:/tmp/old.db
docker compose exec api npm run sqlite-to-postgres -- /tmp/old.db --yes
```
It checks the file, copies everything in one transaction, then compares row counts table by table. It refuses to overwrite a PostgreSQL database that already has farmers or staff (add `--replace` if you really mean it).

## 8. Keep an eye on it
- **System status:** Staff & security → *System status* (admins). It shows the last backup, SMS waiting or failed, weather, the daily advice run, server errors, and a list of warnings.
- **Error alerts:** set `ERROR_WEBHOOK_URL` in `.env` to a Slack, Discord or Microsoft Teams "incoming webhook" URL. Server errors are posted there (at most one alert every 5 minutes).
- **Uptime monitor:** point a free uptime service (e.g. UptimeRobot) at `https://agriconnect.example.org/ready`. It returns 200 only when the app **and** its database answer.
- **Logs:** `docker compose logs --tail 200 api`. Logs are rotated automatically (5 × 10 MB).

## 9. Update to a new version
```bash
cd ~/agriconnect
docker compose -f deploy/docker-compose.yml exec api npm run backup   # backup first
git pull
cd deploy && docker compose up -d --build
docker compose ps        # wait for (healthy)
```
Docker stops the old version cleanly (the server finishes current requests, stops its jobs and closes the database) and restarts automatically if it ever crashes or stops answering.

## Security built in
- HTTPS everywhere (Caddy), with HTTP redirected to HTTPS; browser security headers.
- The app runs as an unprivileged user inside Docker; only Caddy is reachable from the internet.
- Staff: personal accounts, scrypt-hashed passwords, 2-step login required, lockout after 5 wrong tries, 20 login attempts per 10 minutes per IP address, 12-hour sessions, audit log.
- Farmers: SMS-code sign-in, rate-limited; they only see their own data.
- The server refuses to start in production with the dashboard login switched off, or with a real SMS provider and no `WEBHOOK_SECRET`.

## Checklist before real farmers use it
Run the readiness check: it tests most of this list for you and exits with an error while anything blocks the pilot. The same list is on *Staff & security* → *Pilot readiness*.
```bash
docker compose exec api npm run preflight
```

- [ ] HTTPS works at your domain; the uptime monitor is on `/ready`
- [ ] First admin created with `create-admin`; 2-step login on; **no** demo accounts
- [ ] Every officer has their own account with the right counties
- [ ] `WEBHOOK_SECRET` set, provider URLs end in `?secret=…`
- [ ] SMS tested on Lonestar Cell MTN and Orange with team phones
- [ ] Daily off-site copy of `deploy/backups/` set up, and one restore drill done
- [ ] `ERROR_WEBHOOK_URL` set, and a test alert seen
- [ ] Every English advice text approved by an agronomist in *Advice content*
- [ ] System status shows **ALL GOOD**
