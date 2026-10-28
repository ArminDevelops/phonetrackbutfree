# Swiss Apple Store Stock Checker — Design

Date: 2026-10-28 · Status: approved for autonomous build (owner pre-approved the
spec → plan → implement run and is away) · Research: `docs/research/2026-10-28-apple-pickup-availability.md`

## 1. Intent

A private, single-user clone of storestockchecker.com, limited to the four Apple
Stores in Switzerland. The owner wants a push on their phone (via ntfy.sh) within
about half a minute of Apple's online store showing a wanted iPhone configuration
as **available for in-store pickup** at a store they care about — so they can
order for pickup before it sells out again. The current motivating case is the
iPhone Duo, which is unavailable in all four Swiss stores.

A small local web dashboard replaces storestockchecker's website: manage alerts,
see a live stock grid, see restock history.

It is for one person on one Mac. Keep it small and boring; no public-service
engineering.

## 2. Decisions made by the owner

| Topic | Decision |
|---|---|
| Where it runs | On this Mac (macOS), 24/7 as a background service |
| What it tracks | Current iPhone lineup via model/color/storage pickers, **plus** any Apple part number pasted by hand |
| Interface | Small web dashboard: add/remove alerts, live stock grid, restock history |
| Language | TypeScript on Node (Node 22.21 is installed) |
| Notifications | ntfy.sh |

## 3. Goals

- **G1 Alerts.** An alert = one or more exact parts × a subset of the 4 stores.
  When any (part, store) pair of an enabled alert becomes available, send one
  ntfy push within one poll cycle. Tapping the push opens Apple's buy page for
  that exact configuration.
- **G2 Live stock.** A grid of every current iPhone config × 4 stores, refreshed
  continuously in the background (a full sweep every few minutes is enough).
- **G3 Restock history.** A log of when configs became available / sold out at
  each store, with how long they stayed available.
- **G4 Unattended operation.** Starts at login, restarts on crash, survives Mac
  sleep, and **tells the owner via ntfy when it cannot check** (blocked by Apple,
  offline) and when it recovers. Silent failure is the worst outcome.
- **G5 Polite to Apple.** Stay within ~150 requests/hour to Apple, back off
  hard on blocks, so the owner's home IP does not get blocked.

## 4. Non-goals

Other countries; delivery dates; walk-in / carrier / reseller stock; multiple
users or accounts; email or web push; hosting on the internet; Docker; proxies
or IP rotation; a SHIELD/browser-based fallback (documented in research as a
contingency, not built); auto-reserving or auto-checkout.

## 5. Anti-goals (would make it a failure even if it "works")

- **False positives:** a push saying "available" when Apple did not say so —
  e.g. from treating an error, a 541 block page, a missing part, or startup as a
  state change.
- **Silent death:** the checker stops checking (blocked, crashed, offline) and
  the owner doesn't find out.
- **Spam:** repeated pushes for the same stock, or flapping stock producing a
  burst of pushes.
- **Getting the IP blocked** by hammering Apple.
- **Exposure:** dashboard reachable from the network, or a guessable ntfy topic.

## 6. Constraints & facts from research (all verified 2026-10-28)

- Availability source: `GET https://www.apple.com/ch-de/shop/retail/pickup-message?pl=true&mts.0=regular&parts.0=…&location=8001`
  with a desktop browser `User-Agent` and `Accept: application/json`. No cookies.
- Max **20 parts per request** (extra parts silently dropped). `location=8001`
  returns **all 4 Swiss stores** in one response.
- `pickupDisplay` ∈ {`available`, `unavailable`, `ineligible`}. Only
  `available` counts as in stock. Never parse the German quote text for logic.
- `/shop/fulfillment-messages` is SHIELD-protected (HTTP 541) — do not use.
- Rate limiting is per IP and appears as **HTTP 541** (HTML body). During a
  block, results are **unknown**, not "unavailable".
- Catalog: `buy-iphone` index → model slugs → family (slug without dashes) →
  `/ch-de/shop/product-locator-meta?family=<family>`. 73 parts today.
- Generic buy link for any part: `https://www.apple.com/ch-de/shop/product/<PART>`
  (redirects to the preselected buy page). Catalog items also carry `productLink`.
- Product images: `https://store.storeimages.cdn-apple.com/1/as-images.apple.com/is/<image>?wid=240&hei=240&fmt=png-alpha`.
- Recorded responses for tests are in `test/fixtures/apple/`.
- Node 22.21: `node:sqlite` is built in (prints an ExperimentalWarning — suppress it).
  `--env-file-if-exists` is available.

## 7. How it works

One Node process with four parts sharing one SQLite database file:

```
             ┌──────────── Scheduler (every ~30 s ± jitter, backoff on errors)
             │                 │ plans batches of ≤20 parts
             │                 ▼
             │           Apple client ──HTTP──▶ apple.com/ch-de/shop/retail/pickup-message
             │                 │ parsed observations (part, store, status) | blocked | error
             │                 ▼
             │           State update ──▶ availability + restock events (SQLite)
             │                 │
             │                 ▼
             │           Alert evaluator ──▶ ntfy.sh push (aggregated per alert)
             │
Catalog refresher (daily) ──▶ catalog items (SQLite)
Health monitor ──▶ ntfy "can't check" / "recovered" pushes
Web dashboard (127.0.0.1:4321, server-rendered) ◀── reads/writes SQLite
```

### 7.1 Polling & request planning

- Base interval `POLL_INTERVAL_SECONDS` = 30, each wait jittered ±20 %.
- **Watched parts** = union of parts in enabled alerts. Split into batches of 20.
  Spare slots in the last batch (or one whole batch when nothing is watched) are
  filled round-robin with other active catalog parts, so the live grid gets
  refreshed for free. With the 73-part catalog and a few watched parts, the full
  grid is swept every ~2–3 minutes using one request per cycle.
- Request budget: `MAX_REQUESTS_PER_HOUR` = 150. Effective interval =
  `max(base, batchesPerCycle × 3600 / budget)`. Multiple batches in one cycle are
  spaced 2–4 s apart.
- One request per batch with `location=APPLE_LOCATION` (default `8001`),
  15 s timeout. The scheduler never runs two cycles concurrently.

### 7.2 Interpreting responses

| Response | Meaning | Effect |
|---|---|---|
| 200 + JSON with non-empty `body.stores` | success | one observation per (store, part) present in `partsAvailability` |
| requested part missing from a store's `partsAvailability` | unknown | no observation for that pair |
| 200 + JSON but no `body.stores` (verified: a batch containing **only** unknown/foreign parts returns `body.content` and no stores; a bad `location` returns `body.errorMessage`) | **empty** | no observations for that batch; log a warning (include `errorMessage` if present); continue with the next batch |
| HTTP 541 / 403 / 429 | **blocked** | abort the rest of this cycle; blocked backoff |
| network error, timeout, other non-2xx, non-JSON | **error** | abort the rest of this cycle; error backoff |

- Verified 2026-10-28: unknown part numbers and parts from other countries
  (e.g. `MK1E4LL/A`) mixed into a batch with valid parts are **silently dropped**
  — the batch still succeeds for the valid parts. So a bad or discontinued part
  in an alert cannot poison a shared batch; no batch splitting is needed.
- A **cycle** succeeds if at least one batch was a success. If every batch of a
  cycle was `empty`, the cycle counts as an **error** for backoff and health
  (that is what a format change or bad `APPLE_LOCATION` would look like), so it
  can never fail silently.
- 541 is treated as "blocked" whatever its body says (Apple's 541 body is a
  generic "Page Not Found" HTML page).
- The dashboard flags a watched part that has had no observation for 30 minutes
  while cycles are succeeding ("Apple returns no data for this part") — no push.

- Blocked backoff: 90 s → 180 s → 300 s → 600 s (cap), with jitter; no requests
  of any kind to Apple during the wait (catalog refresh and custom-part lookups
  also respect it).
- Error backoff: 30 s → 60 s → 120 s → 300 s (cap).
- Any success resets backoff.
- Stores seen in responses are upserted into a stores table (seeded with the 4
  known stores: R159 Rennweg Zürich, R309 Glattzentrum Wallisellen, R439 Freie
  Strasse Basel, R275 Rue de Rive Genève). If a success returns fewer than the
  known stores, log a warning; missing stores just get no observation.

### 7.3 State, restock events

- `availability` holds the **last known** status per (part, store):
  `available` | `unavailable` (raw `pickupDisplay` and quote kept for display),
  plus `last_checked_at` and `last_changed_at`. Unknown/blocked/error never
  overwrite it.
- When a pair's status changes between two successful observations, record an
  event: `restock` (→ available) or `soldout` (→ unavailable). The first ever
  observation of a pair records no event.
- Restock duration = time from a `restock` event to the next `soldout` for the
  same pair (or "still available").

### 7.4 Alert evaluation & notifications

- Per (alert, part, store) keep a **hit**: `active` flag and `last_notified_at`.
- After each successful batch, for every enabled alert and every (part, store)
  in it that was observed in that batch:
  - observed `available` and hit not active → **notifiable**, unless the last
    push for this pair was less than `RENOTIFY_COOLDOWN_MINUTES` (10) ago, in
    which case mark the hit active without pushing (flap suppression);
  - observed `unavailable` → hit becomes inactive (re-armed).
- A newly created alert whose parts are already available gets a push on the
  first successful observation — "it's there right now" is wanted.
- All notifiable pairs of one alert within one batch → **one** push:
  - Title: `<product title> available` for one part, or `<N> configs available`
    for several (title truncated sensibly).
  - Body: one line per part: product title, then the stores as
    `Rennweg (Zürich), Glattzentrum (Wallisellen)` and Apple's quote
    (e.g. "Verfügbar Heute").
  - `click` = buy link of the first part; up to 3 `view` actions: "Buy" per part
    (first ≤2 parts) and nothing that points at localhost.
  - `priority` 5, `tags` `["iphone"]`, `attach` = product image for single-part
    pushes.
- A hit is marked active (and `last_notified_at` set) only after ntfy accepted
  the push (HTTP 2xx). If ntfy fails, the next cycle tries again naturally. Each
  attempt is logged in a notifications table (time, alert, pairs, ok/error).
- No "sold out" pushes (visible in restock history instead).

### 7.5 Health pushes

- Track `failingSince` = start of the current streak of failed cycles
  (blocked or error); cleared on success.
- If a streak lasts ≥ `HEALTH_ALERT_AFTER_MINUTES` (15): send one push,
  priority 3, e.g. "Stock checker can't reach Apple since 14:05 (blocked,
  HTTP 541). Backing off, retrying." Once per streak.
- When a streak that triggered a health push ends: send "Stock checker recovered
  (was down 23 min)", priority 2.
- **Pauses (Mac asleep / checker not running).** This Mac is a MacBook Air (found
  on battery during design), so it will sleep and checking will pause; nothing
  on the Mac can push while it sleeps. Handling:
  - Persist `last_cycle_at` (time of the last finished cycle, success or not).
    At startup and before every cycle, if `now − last_cycle_at ≥
    PAUSE_ALERT_AFTER_MINUTES` (30), send one push, priority 2: "Checking
    resumed after a 6 h 12 min pause (Mac was asleep or the checker wasn't
    running)". Covers sleep, shutdown and crashes; quick launchd restarts
    (gaps < 30 min) stay silent, so a crash loop cannot spam.
  - A pause also resets the failure streak: if a streak was running when the
    pause was detected, `failingSince` restarts at the time of the first failure
    after the pause, so sleep time never counts as failure time.
  - Optional off-machine dead-man's switch for "it's asleep **right now**":
    if `HEARTBEAT_URL` is set (e.g. a free healthchecks.io check, which can
    itself notify via ntfy), `GET` it after a successful cycle, at most once
    per 5 minutes, fire-and-forget (errors logged only). Off by default; the
    README explains the setup.
- Process start is logged, not pushed (beyond the pause rule above).

### 7.6 Catalog

- Refresh at startup when the catalog is empty or older than 24 h, then every
  24 h, and on demand from the dashboard.
- Steps: fetch `https://www.apple.com/ch-de/shop/buy-iphone`, collect unique slugs
  from `/ch-de/shop/buy-iphone/<slug>` that start with `iphone-`; family = slug
  without dashes; fetch `product-locator-meta?family=` per family 2–3 s apart;
  dedupe by part number.
- Item fields: part number, family, model name, title, color key/label,
  capacity key/label, screen size key, price (CHF, from `"1799_00"`), image key,
  product link, sort order, active flag, updated_at.
- Model name / labels are parsed from `productTitle` with
  `^(.*?)\s(\d+\s?(?:GB|TB))\s(.+)$` → model, capacity label, color label
  (fallback: whole title as model name). Pro and Pro Max share a family but get
  separate model names this way.
- Items that disappear from a successfully fetched family are marked inactive,
  not deleted (alerts may reference them). A failed family fetch leaves its items
  untouched. An unknown family returns 200 JSON without
  `productLocatorOverlayData.productLocatorMeta.products` (verified) — treat that
  as a failed family fetch and log it. If the index page yields no slugs at all,
  keep the whole existing catalog.
- **Custom parts:** the owner can paste any part number (normalize to upper case,
  must look like `^[A-Z0-9]{4,7}[A-Z]{0,3}/A$`). On add, do one pickup-message
  lookup for that part (only if not currently in backoff — otherwise tell the
  owner to retry later): if the response has stores with that part, store it as a
  custom part with `storePickupProductTitle` as title and the generic `/shop/product/<PART>`
  link; if the response is `empty` (verified behaviour for unknown and foreign
  parts), reject with "Apple doesn't know this part for Switzerland". An `empty`
  lookup does not affect backoff or health; a 541 during the lookup does feed
  the normal blocked state. Custom parts are polled like any watched part and
  appear in the live grid under "Custom".

### 7.7 Dashboard

Server-rendered HTML with small progressive enhancement (htmx for auto-refresh
and form posts). English UI; product names stay in Apple's German. Bound to
`127.0.0.1:4321` by default; no auth. Works well on a laptop screen; must not
break on a phone width.

- **Header on every page:** health pill — "Checking · last success 12 s ago",
  "Blocked by Apple · retry 14:12", or "Error · …"; nav: Alerts, Live stock,
  Restocks, Settings. Auto-refreshes.
- **Alerts (`/`):** list of alerts — name (optional, defaults to the product
  titles), parts, stores, a status dot per part × store (available / not / no
  data yet), last pushed time, enable/disable, delete. "New alert": pick a model,
  then tick configs in a color × capacity grid (screen size handled via model
  name), tick stores (default all 4), optional name; or paste a custom part
  number. Editing = delete + recreate (fine for v1).
- **Live stock (`/stock`):** one section per model; rows = configs (title,
  price), columns = the 4 stores; cells green "available" / grey "not
  available" / hatched "no data"; cells older than 10 min look stale; tooltip
  shows Apple's quote and last-checked time. Auto-refresh every ~15 s.
- **Restocks (`/restocks`):** latest 200 events: time, product, store, kind,
  how long it stayed available.
- **Settings (`/settings`):** ntfy server + topic, a subscribe link and a QR code
  of `https://ntfy.sh/<topic>` to scan with the phone, "Send test notification"
  button; read-only view of the poll settings; health details (current state,
  last error, backoff until, requests in the last hour, last success); catalog
  last refreshed + "Refresh catalog now".

### 7.8 Configuration

Environment variables, optionally from `.env` in the project root (loaded via
`node --env-file-if-exists=.env`). All have defaults:

| Variable | Default |
|---|---|
| `PORT` / `HOST` | `4321` / `127.0.0.1` |
| `DATA_DIR` | `./data` (SQLite file lives here; gitignored) |
| `POLL_INTERVAL_SECONDS` | `30` |
| `MAX_REQUESTS_PER_HOUR` | `150` |
| `APPLE_LOCATION` | `8001` |
| `NTFY_SERVER` | `https://ntfy.sh` |
| `NTFY_TOPIC` | empty → generate `apple-ch-<24 random base32 chars>` once and persist in the DB |
| `NTFY_TOKEN` | empty (optional Bearer token) |
| `RENOTIFY_COOLDOWN_MINUTES` | `10` |
| `HEALTH_ALERT_AFTER_MINUTES` | `15` |
| `PAUSE_ALERT_AFTER_MINUTES` | `30` |
| `HEARTBEAT_URL` | empty (optional dead-man's-switch ping URL) |

`.env.example` documents them.

### 7.9 Running on the Mac

- `npm run build` compiles to `dist/`; `npm start` runs it; `npm run dev` runs
  from source with watch.
- `npm run service:install` writes and loads a per-user LaunchAgent
  (`~/Library/LaunchAgents/…plist`): absolute node path (launchd has no shell
  PATH; node here is pnpm-managed), working directory = project, `RunAtLoad`,
  `KeepAlive`, logs to `~/Library/Logs/apple-stock-ch.log`. The program is
  wrapped in `/usr/bin/caffeinate -s` so the Mac doesn't sleep **while on AC
  power**; on battery it sleeps normally and checking pauses. Companion scripts:
  `service:uninstall`, `service:restart`, `service:logs`.
- After wake from sleep the scheduler simply continues; a long gap is logged.

### 7.10 Logging

Structured one-line logs to stdout (picked up by the launchd log file): each
cycle (parts, status, duration), state changes, pushes, backoff transitions,
catalog refreshes. No log rotation needed beyond keeping lines short.

## 8. Testing

- Unit tests (vitest) against the recorded fixtures: response parsing, catalog
  parsing (incl. title regex), batch planning, backoff, alert evaluation
  (including cooldown, re-arming, first-observation push, unknown never changes
  state), ntfy payload building, custom part validation.
- Integration test: the scheduler loop with an injected fake `fetch`, fake clock,
  in-memory SQLite and a fake ntfy endpoint, covering: unavailable → available
  gives exactly one push; staying available gives none; 541 gives no state
  change and backoff; a 15-minute failure streak gives one health push and
  recovery gives one recovery push; an all-`empty` cycle counts as an error but
  a mixed cycle does not; a 6-hour clock jump gives one "resumed" push and does
  not immediately trigger a health push.
- Web: route tests via the app's request handler (pages render, alert create /
  delete, custom part add with a fake Apple response).
- `npm run smoke`: one real pickup-message request printed as a table, plus
  optional real ntfy test push (`--push`). Run once at the end of the build.

## 9. Left to the builder

File layout, table and column names, CSS and visual design (clean, neutral,
light/dark), htmx usage details, exact log format, exact ntfy message wording
within the rules above, library choices within: Hono + `@hono/node-server` with
`hono/jsx`, htmx (served locally, no CDN), `qrcode` for the SVG QR, vitest,
`tsx` for dev. No native modules.

## 10. Calls made by Claude (owner was away — check these)

1. `retail/pickup-message` instead of `fulfillment-messages` (the latter is bot-protected); no browser fallback in v1.
2. 30 s ± 20 % interval, 150 requests/hour budget, long backoff on 541. (storestockchecker does 15 s; we trade a little speed for not getting blocked.)
3. An alert can hold several configs and a subset of stores; one push per alert per cycle; 10-minute re-notify cooldown; no sold-out pushes.
4. Health pushes after 15 minutes of failing, plus a recovery push.
5. Dashboard on localhost only, no auth; product names in German as Apple serves them, UI in English.
6. LaunchAgent with `caffeinate -s` (stay awake on AC only). Because this Mac is a MacBook Air, sleep pauses are expected: you get a "resumed after N h pause" push afterwards, and can optionally set `HEARTBEAT_URL` (healthchecks.io) to be told while it's asleep.
7. SQLite via Node's built-in `node:sqlite`; ntfy topic auto-generated and shown with a QR code.
