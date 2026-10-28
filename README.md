# Abholbereit — Apple Store pickup alerts for Switzerland

A private, single-user take on storestockchecker.com for the four Swiss Apple Stores
(Zürich Rennweg, Glattzentrum Wallisellen, Basel Freie Strasse, Genève Rue de Rive).
It watches Apple's in-store-pickup availability and pushes to your phone via
[ntfy](https://ntfy.sh) the moment a configuration you want can be picked up at a store you chose.

- **Alerts:** one or more exact configurations (model / colour / storage) × any of the four stores,
  or any Apple part number you paste.
- **Live stock:** every current iPhone configuration × 4 stores, refreshed in the background.
- **Restocks:** history of when things came back and how long they lasted.
- **Health pushes:** you're told when Apple blocks the checker, when it recovers, and when it resumes
  after the Mac slept.

It covers reserved **in-store pickup** through apple.com/ch-de only, not walk-in stock, carriers or delivery dates.

## Setup

Requirements: macOS, Node ≥ 22.12 (`node -v`).

```sh
npm install
npm run service:install     # builds, installs and starts a LaunchAgent (runs at login, restarts on crash)
```

Then open the dashboard at <http://127.0.0.1:4321>:

1. **Settings:** install the ntfy app on your phone, scan the QR code (or subscribe to the topic
   shown), then press **Send test notification**.
2. **Alerts → New alert:** pick a model, tick the configurations you'd take and the stores you can reach.

The ntfy topic is generated once (`apple-ch-` + 24 random characters) and stored in the database.
Anyone who knows it can read your pushes, so don't share it.

### Commands

| Command | What it does |
|---|---|
| `npm run service:install` | build + install/replace and start the LaunchAgent |
| `npm run service:restart` | restart it (e.g. after `git pull && npm run build`) |
| `npm run service:logs` | follow `~/Library/Logs/apple-stock-ch.log` |
| `npm run service:status` | launchd's view of the job |
| `npm run service:uninstall` | stop and remove it (your data in `./data` stays) |
| `npm run dev` | run from source with reload (stop the service first, it uses the same port) |
| `npm run deploy -- user@host` | ship the last commit to a Linux server and (re)start it with Docker, see below |
| `npm run smoke` | one live request to Apple, prints the iPhone Duo table; `npm run smoke -- --push` also sends a test push |
| `npm test` / `npm run typecheck` | tests (no network) / type check |

## Run it on a Linux server (Docker)

Any Linux box with Docker + Compose works; an always-on server avoids the laptop sleep problem entirely.

```sh
npm run deploy -- root@your-server          # ships the last commit to /opt/abholbereit and starts it
```

`scripts/deploy.sh` copies the committed code over SSH (no GitHub access needed on the server), creates
`/opt/abholbereit/.env` on first run, and runs `docker compose up -d --build`. Your alerts live in
`/opt/abholbereit/data` and survive redeploys. Run the same command again to update.

The container only listens on the server's `127.0.0.1:4321`. To open the dashboard from your Mac:

```sh
ssh -N -L 4321:127.0.0.1:4321 root@your-server   # keep this running, then open http://localhost:4321
```

On the server:

| | |
|---|---|
| logs | `cd /opt/abholbereit && docker compose logs -f --tail 50` |
| restart / apply `.env` changes | `docker compose up -d` |
| stop | `docker compose down` (data stays) |
| status | `docker compose ps` · `curl -s localhost:4321/api/status` |

### On a subdomain with basic auth

1. In `/opt/abholbereit/.env`, set
   ```
   ALLOWED_HOSTS=stock.example.com
   DASHBOARD_USER=you
   DASHBOARD_PASSWORD=a-long-random-password
   ```
   then `docker compose up -d`. Every page now asks for the password; only `/healthz` stays open.
2. Point the subdomain's DNS at the server and add an nginx site, e.g.
   `/etc/nginx/sites-available/stock.example.com` (link it into `sites-enabled`):
   ```nginx
   server {
       listen 80;
       server_name stock.example.com;
       location / {
           proxy_pass http://127.0.0.1:4321;
           proxy_set_header Host $host;
           proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
           proxy_set_header X-Forwarded-Proto $scheme;
       }
   }
   ```
3. `nginx -t && systemctl reload nginx`, then `certbot --nginx -d stock.example.com` for HTTPS.
   Basic auth sends the password with every request, so only use it over HTTPS.

### Skip the password on your own devices (client certificate)

nginx can ask devices for a certificate signed by your own private CA and vouch for the ones it trusts,
so they never see the password prompt. Everyone else still gets basic auth.

- The app trusts a secret header: `CLIENT_CERT_TOKEN=<long random string>` in `.env`. nginx sends
  `X-Client-Cert-Token` with that value **only** for verified, allow-listed certificates and strips it otherwise.
- In the nginx site's 443 block: `ssl_client_certificate <ca.crt>; ssl_verify_client optional;` and
  `proxy_set_header X-Client-Cert-Token $abholbereit_cert_token;`, with the token in a root-only `map`
  keyed on `"$ssl_client_verify:$ssl_client_serial"` (one line per allowed device; delete a line and reload to revoke).
- Install the device certificate as a password-protected `.p12`: on iPhone, AirDrop it, then
  **Settings → Profile Downloaded → Install**. On a Mac, double-click it to add it to Keychain.
- Works in Safari. Other iOS browsers and home-screen web apps support client certificates less reliably.

### Moving from the Mac to the server

Your alerts and ntfy topic live in `data/stockchecker.db`. To move them (so your phone subscription keeps working):

```sh
npm run service:uninstall                                    # stop the Mac checker (closes the DB cleanly)
ssh root@your-server 'cd /opt/abholbereit && docker compose stop && rm -f data/stockchecker.db*'
scp data/stockchecker.db root@your-server:/opt/abholbereit/data/
ssh root@your-server 'cd /opt/abholbereit && chown 10001:10001 data/stockchecker.db && docker compose start'
```

Run only one checker per topic at a time, or every push arrives twice.

## Configuration

Copy `.env.example` to `.env` and change what you need, then `npm run service:restart`.

| Variable | Default | |
|---|---|---|
| `PORT` / `HOST` | `4321` / `127.0.0.1` | Dashboard address. Keep `127.0.0.1` unless you add basic auth. (Docker sets `0.0.0.0` inside the container and publishes only on the host's `127.0.0.1`.) |
| `DATA_DIR` | `./data` | SQLite database location. |
| `POLL_INTERVAL_SECONDS` | `30` | Base interval, ±20 % jitter. |
| `MAX_REQUESTS_PER_HOUR` | `150` | Hard budget for Apple requests; the interval stretches to respect it. |
| `APPLE_LOCATION` | `8001` | Postcode for the store search; 8001 returns all four stores. |
| `NTFY_SERVER` | `https://ntfy.sh` | |
| `NTFY_TOPIC` | *(generated)* | Set to use your own topic. |
| `NTFY_TOKEN` | — | Bearer token for protected topics / self-hosted ntfy. |
| `RENOTIFY_COOLDOWN_MINUTES` | `10` | Flap guard: no repeat push for the same config + store within this time. |
| `HEALTH_ALERT_AFTER_MINUTES` | `15` | Push a warning after failing this long. |
| `PAUSE_ALERT_AFTER_MINUTES` | `30` | Push "resumed" after a pause at least this long. |
| `HEARTBEAT_URL` | — | Optional dead-man's switch, see below. |
| `ALLOWED_HOSTS` | — | Extra host names the dashboard answers to, e.g. your subdomain. Loopback names always work. |
| `DASHBOARD_USER` / `DASHBOARD_PASSWORD` | — | Turn on basic auth for every page (set both). |
| `CLIENT_CERT_TOKEN` | — | Secret nginx adds for verified client certificates, which then skip basic auth (see above). |

## Sleep and battery

The checker can only check while the Mac is awake.

- The LaunchAgent wraps the process in `caffeinate -s`, so the Mac stays awake **while on power**.
  On battery, or with the lid closed (unless an external display is attached), it sleeps as usual
  and checking pauses.
- When it wakes, you get a **"Stock checker resumed after …"** push, so pauses are never silent
  in hindsight.
- To be told **while** it's asleep, set `HEARTBEAT_URL` to a free [healthchecks.io](https://healthchecks.io)
  check (period 5 min, grace ~15 min) and connect healthchecks.io's ntfy integration to the same topic.
  The checker pings it after a successful check, at most every 5 minutes.

## How it works

- **Availability:** `GET https://www.apple.com/ch-de/shop/retail/pickup-message?pl=true&mts.0=regular&parts.0=…&location=8001`
  returns per-store `pickupDisplay` (`available` / `unavailable` / `ineligible`) for up to 20 parts across all
  four Swiss stores in one request. Only `available` counts.
- **Batching:** the parts you watch go first in each request; spare slots are filled round-robin with the
  rest of the catalog, so the live grid refreshes without extra requests. With a few alerts that's one
  request every ~30 s.
- **Catalog:** discovered daily from `/ch-de/shop/buy-iphone` (model pages) and
  `/ch-de/shop/product-locator-meta?family=…` (part numbers, titles, prices, buy links).
- **Being polite:** Apple rate-limits per IP and answers **HTTP 541** when it does. The checker then stops
  completely and backs off 90 s → 3 min → 5 min → 10 min. Network and other errors back off
  30 s → 1 → 2 → 5 min. A blocked or failed check never counts as "sold out", and never triggers a push.
- **Pushes:** one push per alert per check, listing every newly available config and store. Tapping it
  opens Apple's buy page for that configuration. Stock that stays available never pushes twice, and
  that survives restarts.
- `/shop/fulfillment-messages`, which older tools use, is behind Apple's "SHIELD" bot check and needs a real
  browser. The research notes explain how that could be added back if Apple ever shields `pickup-message`
  as well: [`docs/research/2026-10-28-apple-pickup-availability.md`](docs/research/2026-10-28-apple-pickup-availability.md).

## Troubleshooting

- **"Blocked by Apple" in the header:** expected now and then. It backs off and recovers on its own.
  If it happens a lot, raise `POLL_INTERVAL_SECONDS` or lower `MAX_REQUESTS_PER_HOUR`.
- **Nothing in Live stock:** the catalog loads ~20 s after start. **Settings → Refresh catalog now**
  forces it.
- **No pushes:** check **Settings → Recent notifications** for errors, and make sure the phone is subscribed
  to the exact topic.
- **Logs:** `npm run service:logs`. One line per check (`cycle outcome=success requests=1 …`), per stock change and per push.

## Project docs

- Design spec: `docs/superpowers/specs/2026-10-28-swiss-apple-stock-checker-design.md`
- Implementation plan: `docs/superpowers/plans/2026-10-28-swiss-apple-stock-checker.md`
- Research: `docs/research/2026-10-28-apple-pickup-availability.md`
