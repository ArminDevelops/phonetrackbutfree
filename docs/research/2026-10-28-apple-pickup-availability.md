# Research: Apple Store pickup availability (Switzerland)

Date: 2026-10-28. Everything marked **verified** was observed live from a Swiss
residential IP (this Mac) on that date. Raw responses live in `test/fixtures/apple/`.

## TL;DR

- Use `GET https://www.apple.com/ch-de/shop/retail/pickup-message` — plain HTTP,
  no cookies, browser-like `User-Agent`. **Verified.**
- Do **not** use `/ch-de/shop/fulfillment-messages` — it is behind Apple's
  "SHIELD" bot check and answers HTTP 541 + an HTML "Page Not Found" page to
  anything that is not a real, non-automated browser. **Verified.**
- One request covers up to **20 parts** × **all 4 Swiss stores**. **Verified.**
- Catalog (part numbers, titles, prices, deep links) comes from
  `/ch-de/shop/product-locator-meta?family=<family>`. **Verified.**
- Rate limiting is per IP and shows up as HTTP 541. Community reports: ~30
  back-to-back requests trigger it; ≤150 requests/hour with jitter is reported as
  safe for long runs. **Not verified by us** (we did not try to trigger it).

## Availability endpoint

```
GET https://www.apple.com/ch-de/shop/retail/pickup-message
    ?pl=true
    &mts.0=regular
    &parts.0=MK2D4QL%2FA&parts.1=...      (max 20 — extra parts are silently dropped)
    &location=8001                        (Swiss postcode; or &store=R275 for one store)
Headers: User-Agent: <desktop Safari/Chrome UA>, Accept: application/json
```

- With `location=8001` (Zürich) all 4 Swiss stores come back, ranked by distance
  (Geneva is 224 km away and still included). From `location=9000` (St. Gallen)
  only 3 came back — the search radius is finite. Zürich/Bern postcodes cover all four.
- `store=R275` returns only that store.
- Response: `{ head: { status: "200", data: {} }, body: { stores: [...], ... } }`.
  (The older `body.content.pickupMessage.stores` envelope belongs to
  fulfillment-messages, not this endpoint.)
- Per store: `storeNumber`, `storeName`, `city`, `storeDistanceWithUnit`,
  `address { address, address2, postalCode }`, `storeHours.hours[]`,
  `retailStore { latitude, longitude, phoneNumber, email, ... }`,
  `partsAvailability { [partNumber]: {...} }`.
- Per part per store:

```json
{
  "storePickEligible": true,
  "pickupSearchQuote": "Verfügbar Heute",
  "partNumber": "MG6J4QL/A",
  "pickupDisplay": "available",
  "pickupType": "Abholung Im Store",
  "messageTypes": { "regular": {
      "storeSelectionEnabled": true,
      "storePickupQuote": "Heute im Apple Rennweg",
      "storePickupProductTitle": "iPhone 17 256 GB Schwarz",
      "basePartNumber": "MG6J4" } }
}
```

- `pickupDisplay` values seen: `available` (quote "Verfügbar Heute"),
  `unavailable` and `ineligible` (both quote "Derzeit nicht verfügbar",
  `storeSelectionEnabled: false`). Key off `pickupDisplay`, never the German text.
  Treat `unavailable` and `ineligible` as "not available".
- Snapshot on 2026-10-28 ~15:00: iPhone Duo (all 8 configs) unavailable in all 4
  stores; most other iPhones available somewhere.

## Swiss Apple Stores (verified, 4 total)

| Store no. | Name          | City        | Address            |
|-----------|---------------|-------------|--------------------|
| R159      | Rennweg       | Zürich      | Rennweg 43, 8001   |
| R309      | Glattzentrum  | Wallisellen |                    |
| R439      | Freie Strasse | Basel       |                    |
| R275      | Rue de Rive   | Genève      |                    |

## Catalog

- Model list: `GET /ch-de/shop/buy-iphone` (HTML). Model slugs appear as
  `https://www.apple.com/ch-de/shop/buy-iphone/<slug>` inside embedded JSON.
  Current slugs: `iphone-duo`, `iphone-18-pro` (Pro + Pro Max on one page),
  `iphone-air`, `iphone-17`, `iphone-17e`, `iphone-16`. Ignore `carrier-offers`.
- Family name = slug with dashes removed (`iphone-18-pro` → `iphone18pro`).
  Holds for all current models. (`iphone18promax` returns the same list as
  `iphone18pro`, so dedupe by part number.)
- `GET /ch-de/shop/product-locator-meta?family=<family>` →
  `body.productLocatorOverlayData.productLocatorMeta.products[]`:

```json
{
  "productTitle": "iPhone 18 Pro 1 TB Schwarz",
  "basePartNumber": "MJRY4",
  "image": "iphone-18-pro-finish-select-black-202609",
  "dimensionCapacity": "1tb",
  "price": "1799_00",
  "dimensionScreensize": "6_3inch",
  "partNumber": "MJRY4QL/A",
  "productLink": "https://www.apple.com/ch-de/shop/buy-iphone/iphone-18-pro/6,3%22-display-1tb-schwarz",
  "dimensionColor": "black"
}
```

  Also `displayValues.dimensionColor` / `dimensionCapacity` with localized labels
  (HTML snippets — strip tags) and `sortOrder`.
- Counts: iphoneduo 8, iphone18pro 32, iphoneair 12, iphone17 10, iphone17e 6,
  iphone16 5 → 73 parts. Swiss part numbers end in `QL/A`.
- Product image: `https://store.storeimages.cdn-apple.com/1/as-images.apple.com/is/<image>?wid=240&hei=240&fmt=png-alpha`
  (verified 200, PNG).
- Generic buy link for any part: `https://www.apple.com/ch-de/shop/product/<PART>`
  301-redirects to the preselected buy page (verified for `MK2D4QL/A`).
  Use this for custom part numbers that are not in the catalog.

## SHIELD (why fulfillment-messages fails) — contingency only

Not needed for v1, recorded in case Apple also shields `retail/pickup-message`.

- Buy pages load `/shop/shld/s3/verify.js`, which fingerprints the browser and
  solves a proof-of-work via `/shop/shld/work/s3/q?jr=<n>`, then sets cookies
  `shld_bt_m`, `sh_spksy`, `shld_bt_ck`.
- Minimum cookies for fulfillment-messages: `dssid2` + `shld_bt_ck`, plus the
  **same User-Agent** that produced them. The token is reusable for many requests
  (server sends `Set-Cookie: shld_bt_ck=; Expires=1970` on each response, but does
  not enforce it). `shld_bt_ck` embeds an expiry ~2 h after issue.
- `jr` looks like a risk score: real Chrome / stealthy Playwright → `jr=30`;
  plain Playwright (navigator.webdriver = true) or HeadlessChrome UA → `jr=100`;
  headless with spoofed UA → `jr=90`. Tokens from high-`jr` sessions are rejected.
- Playwright Chromium launched with
  `args: ["--disable-blink-features=AutomationControlled"], ignoreDefaultArgs: ["--enable-automation"]`
  (headed, can be positioned off-screen) got a working token ~60–70 % of attempts.
  Retrying a few times would make it practical. Harvested cookies then work from
  plain Node `fetch` with the same UA.
- Public repos using the same contingency: drewster99/mac-availability-tracker
  (`shield.py`), westonfw/iphone-hunter.

## Rate limiting — our own measurement (2026-10-28)

- Home IP (Swiss residential): polling `retail/pickup-message` every ~30 s (±20 %), one request per
  cycle, got HTTP 541 after ~30 min (it had also seen heavy research traffic earlier that day).
- cloud server IP (clean, no prior traffic except 8 test requests): same polling → 541 after ~28 min.
- Blocks lasted at least 15 minutes, and probes during the block (container restarts) likely extended it.
- Conclusion: ~2 requests/minute sustained is too much; the "≤150/h is safe" community figure did not hold.
  Default lowered to one request every ~90 s (≤45/h) and backoff now persists across restarts.

## Rate limiting (community reports, unverified)

- ENCHIGO/apple-pickup-watcher: ~30 back-to-back requests → 541 for 10–15 min, per IP.
- westonfw/iphone-hunter: blocks lifted after a median of ~79 s; probing during a
  block extends it; changing UA does not help. They pause 90/180/300 s, cap at
  150 req/h, base interval 30 s with jitter.
- Datacenter IPs get blocked faster (Fly.io within hours); residential mostly fine.
- During a 541 the result is **unknown**, never "unavailable".

## storestockchecker.com (what we are cloning)

- Alerts for one exact config (model/color/storage) at up to 5 chosen stores;
  checks every 15 s; web push + email; "live stock" pages per config;
  "restocks" history page. Free to view, paid alerts.
- Catalog uses the same family names/image keys as product-locator-meta.
- Covers in-store pickup only — not walk-in, carrier, or delivery dates. Same for us.

## ntfy.sh

- Publish JSON: `POST https://ntfy.sh/` with
  `{ topic, message, title, tags[], priority 1–5, click, actions[], attach, icon, markdown }`.
- Actions (max 3): `{ action: "view", label, url, clear? }`.
- Priority 5 = urgent (long vibration bursts, pop-over); 2 = low (silent).
- Message ≤ 4096 bytes; topic `[A-Za-z0-9_-]{1,64}`; anyone who knows the topic
  name can subscribe, so use a long random one.
- Optional auth: `Authorization: Bearer <token>`.
- ntfy.sh limits anonymous publishers (burst then throttled, daily cap). Our volume
  is a handful of messages per day; we still aggregate per poll cycle.
