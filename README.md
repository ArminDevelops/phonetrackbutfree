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
| `npm run smoke` | one live request to Apple, prints the iPhone Duo table; `npm run smoke -- --push` also sends a test push |
| `npm test` / `npm run typecheck` | tests (no network) / type check |

## Configuration

Copy `.env.example` to `.env` and change what you need, then `npm run service:restart`.

| Variable | Default | |
|---|---|---|
| `PORT` / `HOST` | `4321` / `127.0.0.1` | Dashboard address. Keep `127.0.0.1`: there's no login. |
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
