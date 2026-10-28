# Swiss Apple Store Stock Checker Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A single-user Node service on this Mac that polls Apple's Swiss in-store-pickup availability for iPhones (and hand-entered part numbers), pushes restocks to ntfy.sh, and serves a small localhost dashboard (alerts, live stock grid, restock history, settings).

**Architecture:** One Node process: a `Checker` loop plans ≤20-part batches, calls `retail/pickup-message`, applies observations to SQLite (`node:sqlite`), evaluates alerts and pushes via ntfy; an `AppleGate` owns backoff and request accounting for every Apple call; a `HealthMonitor` emits degraded/recovered/resumed pushes. A Hono server renders the dashboard with `hono/jsx` and uses htmx only for auto-refresh partials; forms are plain POST + 303 redirect.

**Tech Stack:** Node 22.21, TypeScript (ESM, `nodenext`), Hono + `@hono/node-server`, `hono/jsx`, htmx.org (served from node_modules), `qrcode`, `node:sqlite`, vitest, tsx.

**Spec:** `docs/superpowers/specs/2026-10-28-swiss-apple-stock-checker-design.md` (research: `docs/research/2026-10-28-apple-pickup-availability.md`). Read both before starting.

## Global Constraints

- `package.json` `"type": "module"`; `tsconfig` `module`/`moduleResolution` `nodenext`, `strict`, `jsx: "react-jsx"`, `jsxImportSource: "hono/jsx"`; relative imports end in `.js`.
- Runtime deps only: `hono`, `@hono/node-server`, `htmx.org`, `qrcode`. Dev deps only: `typescript`, `tsx`, `vitest`, `@types/node@^22`, `@types/qrcode`. No native modules. If TypeScript 7 misbehaves, pin `typescript@~5.9`.
- SQLite only through `node:sqlite` `DatabaseSync`. Run node with `--disable-warning=ExperimentalWarning`.
- Apple base URL `https://www.apple.com/ch-de/shop/`; every Apple request sends `User-Agent: Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15` and `Accept: application/json`; timeout 15 s.
- Max 20 parts per pickup request. Only `pickupDisplay === "available"` is available; `unavailable` and `ineligible` map to `"unavailable"`. Never parse German text for logic.
- No request to Apple while `AppleGate.isOpen()` is false. Every Apple request calls `gate.countRequest()` first.
- Blocked backoff 90/180/300/600 s (cap); error backoff 30/60/120/300 s (cap); ±20 % jitter.
- Defaults: `PORT=4321`, `HOST=127.0.0.1`, `DATA_DIR=./data`, `POLL_INTERVAL_SECONDS=30`, `MAX_REQUESTS_PER_HOUR=150`, `APPLE_LOCATION=8001`, `NTFY_SERVER=https://ntfy.sh`, `NTFY_TOPIC` empty, `NTFY_TOKEN` empty, `RENOTIFY_COOLDOWN_MINUTES=10`, `HEALTH_ALERT_AFTER_MINUTES=15`, `PAUSE_ALERT_AFTER_MINUTES=30`, `HEARTBEAT_URL` empty.
- User-visible times are formatted in `Europe/Zurich` regardless of host TZ.
- UI copy in English; Apple product titles shown verbatim (German).
- Tests never touch the network: fixtures in `test/fixtures/apple/`, fakes injected.
- Commit after each task.

## Review Focus

1. Apple answers **HTTP 200 with an HTML page** (maintenance, redirect page) → must be `error` with backoff, never a state change or crash. Test added to Task 2.
2. An alert references a part **missing from the catalog** (deactivated, or catalog not loaded yet) → push and pages fall back to the observation title / part number and the generic `/shop/product/<PART>` link. Tests added to Tasks 7 and 11.
3. **Process restart while stock stays available** (launchd restart, reboot) → no duplicate push, because hits live in SQLite. Test added to Task 9.
4. **Alert form submitted with nothing ticked or a tampered part number** → 400 with a message, nothing created. Tests added to Task 11.
5. **Host timezone differs** (launchd env, UTC) → push/dashboard times still Europe/Zurich. Test added to Task 1 (`formatTime` uses an explicit `timeZone`).

---

### Task 1: Scaffold, config, time helpers

**Files:**
- Create: `package.json`, `tsconfig.json`, `vitest.config.ts`, `.env.example`, `src/config.ts`, `src/log.ts`, `src/time.ts`
- Test: `test/config.test.ts`, `test/time.test.ts`, `test/jsx-smoke.test.tsx`

**Interfaces:**
- Produces:
  - `interface Config { port: number; host: string; dataDir: string; pollIntervalSeconds: number; maxRequestsPerHour: number; appleLocation: string; ntfyServer: string; ntfyTopic: string | null; ntfyToken: string | null; renotifyCooldownMinutes: number; healthAlertAfterMinutes: number; pauseAlertAfterMinutes: number; heartbeatUrl: string | null }`
  - `loadConfig(env: Record<string, string | undefined>): Config` — throws `Error` naming the variable on invalid input.
  - `log(event: string, fields?: Record<string, unknown>): void` — one stdout line: ISO time, event, `key=value` pairs (strings JSON-quoted if they contain spaces).
  - `interface Clock { now(): number }`, `const systemClock: Clock`
  - `formatTime(ms: number): string` → `"HH:MM"` in Europe/Zurich; `formatDateTime(ms: number): string` → `"28.10. 14:05"`; `formatDuration(ms: number): string`; `ago(ms: number, now: number): string` → `"12 s ago"`, `"5 min ago"`, `"3 h ago"`.

- [ ] **Step 1: Scaffold.** `npm init`, set `"type": "module"`, install deps per Global Constraints, scripts: `build` (`tsc -p tsconfig.json`), `typecheck` (`tsc --noEmit`), `test` (`vitest run`), `dev` (`NODE_OPTIONS=--disable-warning=ExperimentalWarning tsx watch src/main.ts`), `start` (`node --disable-warning=ExperimentalWarning dist/main.js`), `smoke` (`NODE_OPTIONS=--disable-warning=ExperimentalWarning tsx scripts/smoke.ts`), `service:install|uninstall|restart|logs|status` (`bash scripts/service.sh <cmd>`). `tsconfig`: `target es2023`, `rootDir src`, `outDir dist`, include `src`. `vitest.config.ts`: include `test/**/*.test.{ts,tsx}`, JSX import source `hono/jsx` (configure whichever transformer this vitest version uses — `oxc.jsx.importSource` or `esbuild.jsxImportSource`), `NODE_OPTIONS` warning suppression not needed in tests. `.env.example` lists every variable with its default and a one-line comment.

- [ ] **Step 2: Write failing tests**

```ts
// test/config.test.ts
test("defaults", () => expect(loadConfig({})).toEqual({ port: 4321, host: "127.0.0.1", dataDir: "./data", pollIntervalSeconds: 30, maxRequestsPerHour: 150, appleLocation: "8001", ntfyServer: "https://ntfy.sh", ntfyTopic: null, ntfyToken: null, renotifyCooldownMinutes: 10, healthAlertAfterMinutes: 15, pauseAlertAfterMinutes: 30, heartbeatUrl: null }));
test("overrides", () => { const c = loadConfig({ POLL_INTERVAL_SECONDS: "45", NTFY_SERVER: "https://ntfy.example.com/", NTFY_TOPIC: "my_topic-1", HEARTBEAT_URL: "https://hc-ping.com/x" }); expect(c.pollIntervalSeconds).toBe(45); expect(c.ntfyServer).toBe("https://ntfy.example.com"); expect(c.ntfyTopic).toBe("my_topic-1"); expect(c.heartbeatUrl).toBe("https://hc-ping.com/x"); });
test("empty strings are unset", () => expect(loadConfig({ NTFY_TOPIC: "", NTFY_TOKEN: "" }).ntfyTopic).toBeNull());
test.each([["POLL_INTERVAL_SECONDS", "abc"], ["POLL_INTERVAL_SECONDS", "0"], ["PORT", "-1"], ["APPLE_LOCATION", "800"], ["APPLE_LOCATION", "0800"], ["NTFY_TOPIC", "has space"]])("rejects %s=%s", (k, v) => expect(() => loadConfig({ [k]: v })).toThrow(k));
// test/time.test.ts
test("formatTime is Zurich time", () => expect(formatTime(Date.UTC(2026, 9, 28, 13, 5))).toBe("14:05"));
test("formatDateTime", () => expect(formatDateTime(Date.UTC(2026, 9, 28, 13, 5))).toBe("28.10. 14:05"));
test.each([[6 * 3600e3 + 12 * 60e3, "6 h 12 min"], [2 * 3600e3, "2 h"], [23 * 60e3, "23 min"], [45e3, "45 s"]])("formatDuration(%i)", (ms, s) => expect(formatDuration(ms)).toBe(s));
test("ago", () => { expect(ago(0, 12e3)).toBe("12 s ago"); expect(ago(0, 5 * 60e3)).toBe("5 min ago"); expect(ago(0, 3 * 3600e3)).toBe("3 h ago"); });
// test/jsx-smoke.test.tsx
test("hono jsx renders", () => expect((<p>hi</p>).toString()).toBe("<p>hi</p>"));
```

- [ ] **Step 3: Run** `npx vitest run` → FAIL (modules missing).
- [ ] **Step 4: Implement** `src/config.ts`, `src/time.ts` (use `Intl.DateTimeFormat("de-CH", { timeZone: "Europe/Zurich", ... })`), `src/log.ts`. APPLE_LOCATION regex `^[1-9]\d{3}$`; topic regex `^[A-Za-z0-9_-]{1,64}$`; positive integers for numeric vars.
- [ ] **Step 5: Run** `npx vitest run && npm run typecheck` → PASS.
- [ ] **Step 6: Commit** `chore: scaffold project with config and time helpers`.

---

### Task 2: Apple client and pickup parsing

**Files:**
- Create: `src/apple/types.ts`, `src/apple/pickup.ts`, `src/apple/client.ts`, `src/apple/stores.ts`
- Test: `test/apple/pickup.test.ts`, `test/apple/client.test.ts`

**Interfaces:**
- Produces (`src/apple/types.ts`):
  - `type PickupStatus = "available" | "unavailable"`
  - `interface StoreInfo { storeNumber: string; name: string; city: string }`
  - `interface Observation { partNumber: string; storeNumber: string; status: PickupStatus; pickupDisplay: string; quote: string; productTitle: string }` (`quote` = `pickupSearchQuote`, `productTitle` = `messageTypes.regular.storePickupProductTitle`, `""` if absent)
  - `type BatchResult = { kind: "success"; stores: StoreInfo[]; observations: Observation[] } | { kind: "empty"; message?: string } | { kind: "blocked"; httpStatus: number } | { kind: "error"; message: string }`
  - `interface CatalogItem { partNumber: string; family: string; modelName: string; title: string; colorKey: string; colorLabel: string; capacityKey: string; capacityLabel: string; screensizeKey: string | null; priceChf: number | null; imageKey: string | null; productLink: string; sortOrder: number }`
- Produces (`src/apple/pickup.ts`): `APPLE_BASE`, `APPLE_USER_AGENT`, `MAX_PARTS_PER_REQUEST = 20`, `buildPickupPath(parts: string[], location: string): string`, `parsePickupJson(text: string): BatchResult` (only `success | empty | error`).
- Produces (`src/apple/client.ts`): `type AppleResponse = { kind: "ok"; text: string } | { kind: "blocked"; httpStatus: number } | { kind: "error"; message: string }`; `interface AppleClient { get(path: string): Promise<AppleResponse>; pickup(parts: string[], location: string): Promise<BatchResult> }`; `createAppleClient(opts?: { fetch?: typeof fetch; timeoutMs?: number }): AppleClient`.
- Produces (`src/apple/stores.ts`): `KNOWN_STORES: StoreInfo[]` = R159 Rennweg Zürich, R309 Glattzentrum Wallisellen, R439 Freie Strasse Basel, R275 Rue de Rive Genève (this order).

- [ ] **Step 1: Write failing tests**

```ts
// pickup.test.ts
expect(buildPickupPath(["MK2D4QL/A", "MK2E4QL/A"], "8001")).toBe("retail/pickup-message?pl=true&mts.0=regular&parts.0=MK2D4QL%2FA&parts.1=MK2E4QL%2FA&location=8001");
expect(() => buildPickupPath([], "8001")).toThrow(); expect(() => buildPickupPath(Array(21).fill("A"), "8001")).toThrow();
// 20-part fixture
const r = parsePickupJson(fixture("pickup-message-20parts.json"));
expect(r.kind).toBe("success"); expect(r.stores.map(s => s.storeNumber)).toEqual(["R159", "R309", "R439", "R275"]);
expect(r.stores[0]).toEqual({ storeNumber: "R159", name: "Rennweg", city: "Zürich" }); expect(r.observations).toHaveLength(80);
expect(find(r, "MK2D4QL/A", "R159")).toMatchObject({ status: "unavailable", pickupDisplay: "unavailable", quote: "Derzeit nicht verfügbar", productTitle: "iPhone Duo 256 GB Sternenweiß" });
expect(find(r, "MJY04QL/A", "R159")).toMatchObject({ status: "available", quote: "Verfügbar Heute", productTitle: "iPhone 18 Pro Max 1 TB Burgunder" });
// "ineligible maps to unavailable": mutate a parsed copy of the fixture JSON, set pickupDisplay "ineligible", re-stringify → status "unavailable", pickupDisplay "ineligible"
expect(parsePickupJson(fixture("pickup-message-single-store.json"))).toMatchObject({ kind: "success", stores: [{ storeNumber: "R275", name: "Rue de Rive", city: "Genève" }] });
expect(parsePickupJson(fixture("pickup-message-unknown-part-only.json"))).toEqual({ kind: "empty" });
expect(parsePickupJson('{"head":{"status":"200"},"body":{"errorMessage":"Bitte gib eine gültige Stadt oder Postleitzahl ein."}}')).toEqual({ kind: "empty", message: "Bitte gib eine gültige Stadt oder Postleitzahl ein." });
expect(parsePickupJson("<!doctype html><html>…</html>")).toMatchObject({ kind: "error" }); // Review Focus 1
// client.test.ts (fake fetch records url + headers)
// - requests APPLE_BASE + path with the UA and accept headers
// - 541, 403, 429 → { kind: "blocked", httpStatus }; 500 → { kind: "error", message: "HTTP 500" }; 404 → error
// - fetch rejects → error with the rejection message; never-resolving fetch honouring AbortSignal with timeoutMs 50 → error matching /timeout/i
// - pickup(): 200 + 20-part fixture → success; 541 → blocked; 200 + HTML body → error (Review Focus 1)
```

- [ ] **Step 2: Run** `npx vitest run test/apple` → FAIL.
- [ ] **Step 3: Implement.** `parsePickupJson`: JSON.parse failure → `error` ("Apple returned non-JSON"); `body.stores` missing/empty → `empty` with `body.errorMessage` if present; otherwise map stores and their `partsAvailability` entries. Client uses `AbortSignal.timeout(timeoutMs)` (default 15 000).
- [ ] **Step 4: Run** `npx vitest run test/apple` → PASS.
- [ ] **Step 5: Commit** `feat: Apple pickup-message client and parser`.

---

### Task 3: Database and repository

**Files:**
- Create: `src/db/db.ts`, `src/db/repo.ts`
- Test: `test/db/repo.test.ts`

**Interfaces:**
- Consumes: `CatalogItem`, `StoreInfo`, `PickupStatus` (Task 2), `KNOWN_STORES`.
- Produces:
  - `openDb(file: string): DatabaseSync` — `":memory:"` allowed; otherwise creates the parent dir and sets `PRAGMA journal_mode=WAL`; creates all tables with `CREATE TABLE IF NOT EXISTS`.
  - `interface CatalogRow extends CatalogItem { active: boolean; isCustom: boolean; updatedAt: number }`
  - `interface Alert { id: number; name: string | null; enabled: boolean; createdAt: number; partNumbers: string[]; storeNumbers: string[] }`
  - `interface AvailabilityRow { partNumber: string; storeNumber: string; status: PickupStatus; pickupDisplay: string; quote: string; productTitle: string; lastCheckedAt: number; lastChangedAt: number }`
  - `interface EventRow { id: number; partNumber: string; storeNumber: string; kind: "restock" | "soldout"; at: number }`
  - `interface HitRow { alertId: number; partNumber: string; storeNumber: string; active: boolean; lastNotifiedAt: number | null }`
  - `interface NotificationLog { at: number; kind: "restock" | "health" | "test"; alertId: number | null; title: string; ok: boolean; error: string | null }`
  - `class Repo` (constructor seeds `KNOWN_STORES` with `INSERT OR IGNORE`, sort order = index):
    `getSetting(key): string | undefined`, `setSetting(key, value): void`,
    `upsertCatalogItems(items: CatalogItem[], now: number): void` (sets active),
    `deactivateMissing(family: string, keep: string[], now: number): number`,
    `addCustomPart(partNumber: string, title: string, now: number): void` (family `"custom"`, modelName `"Custom"`, colorKey/capacityKey `""`, labels `""`, productLink `https://www.apple.com/ch-de/shop/product/<PART>`, sortOrder 9999, isCustom),
    `getCatalogItem(partNumber): CatalogRow | undefined`, `listCatalog(opts?: { activeOnly?: boolean }): CatalogRow[]` (order: sortOrder, modelName, title),
    `upsertStores(stores: StoreInfo[]): void` (new stores get sort order 100+), `listStores(): StoreInfo[]` (by sort order),
    `createAlert(input: { name: string | null; partNumbers: string[]; storeNumbers: string[] }, now: number): number` (throws `"at least one part"` / `"at least one store"`), `getAlert(id): Alert | undefined`, `listAlerts(): Alert[]` (newest first), `setAlertEnabled(id, enabled): void` (enabling deletes the alert's hits), `deleteAlert(id): void` (cascades parts, stores, hits), `watchedParts(): string[]` (distinct parts of enabled alerts, sorted),
    `getAvailability(part, store): AvailabilityRow | undefined`, `listAvailability(): AvailabilityRow[]`, `upsertAvailability(row: AvailabilityRow): void`,
    `insertEvent(e: Omit<EventRow, "id">): void`, `listEvents(limit: number): EventRow[]` (newest first),
    `getHit(alertId, part, store): HitRow | undefined`, `upsertHit(hit: HitRow): void`, `listHits(alertId): HitRow[]`,
    `logNotification(n: NotificationLog): void`, `listNotifications(limit: number): (NotificationLog & { id: number })[]` (newest first).

- [ ] **Step 1: Write failing tests** (in-memory DB unless noted):
  - settings roundtrip; unknown key → `undefined`.
  - catalog: upsert the 8 Duo items (build by hand or via a small helper — Task 5's parser is not available yet), `deactivateMissing("iphoneduo", ["MK2D4QL/A"], t)` returns 7; `listCatalog({ activeOnly: true })` has 1; re-upsert reactivates all 8.
  - `addCustomPart("MXP63ZM/A", "AirPods Pro", t)` → `getCatalogItem` has `isCustom: true`, `productLink: "https://www.apple.com/ch-de/shop/product/MXP63ZM/A"`, `active: true`.
  - stores: fresh repo `listStores().map(s => s.storeNumber)` = `["R159", "R309", "R439", "R275"]`; `upsertStores([{ storeNumber: "R999", name: "X", city: "Y" }])` appends it last.
  - alerts: create/list roundtrip (parts and stores arrays intact); `createAlert` with `[]` parts throws /at least one part/, with `[]` stores throws /at least one store/; `watchedParts()` = distinct, sorted, excludes disabled; `setAlertEnabled(id, true)` clears hits; `deleteAlert` removes hits too.
  - availability upsert/get; `listEvents(2)` returns the 2 newest.
  - persistence: temp-dir file DB, create alert, close, `openDb` again → alert present.
- [ ] **Step 2: Run** `npx vitest run test/db` → FAIL.
- [ ] **Step 3: Implement** with prepared statements; booleans stored as 0/1; alert parts/stores in join tables.
- [ ] **Step 4: Run** `npx vitest run test/db` → PASS.
- [ ] **Step 5: Commit** `feat: SQLite repository`.

---

### Task 4: Batching and the Apple gate

**Files:**
- Create: `src/core/batching.ts`, `src/core/gate.ts`
- Test: `test/core/batching.test.ts`, `test/core/gate.test.ts`

**Interfaces:**
- Consumes: `Clock` (Task 1).
- Produces:
  - `planBatches(watched: string[], fill: string[], cursor: number, max = 20): { batches: string[][]; nextCursor: number }`
  - `BLOCKED_BACKOFF_S = [90, 180, 300, 600]`, `ERROR_BACKOFF_S = [30, 60, 120, 300]`, `type FailureKind = "blocked" | "error"`
  - `jitter(ms: number, random: () => number, fraction = 0.2): number` → `Math.round(ms * (1 + fraction * (2 * random() - 1)))`
  - `class AppleGate { constructor(clock: Clock, random?: () => number); isOpen(): boolean; readonly backoffUntil: number | null; readonly lastFailure: { kind: FailureKind; message: string; at: number } | null; readonly consecutiveFailures: number; countRequest(): void; requestsLastHour(): number; reportSuccess(): void; reportFailure(kind: FailureKind, message: string): void }`

`planBatches` algorithm: dedupe `watched` (keep order) and chunk it by `max`. Spare slots = `max − size of last chunk` (or `max` when nothing is watched, creating one batch). Candidates = `fill` minus watched. Take `min(spare, candidates.length)` candidates starting at `cursor % candidates.length`, wrapping. `nextCursor = (start + taken) % candidates.length` (0 when there are no candidates). Drop a batch that ends up empty.

- [ ] **Step 1: Write failing tests**
  - `fill` = 73 ids `p0..p72`, no watched, cursor 0 → one batch `p0..p19`, `nextCursor` 20; cursor 60 → `p60..p72, p0..p6`, `nextCursor` 7.
  - watched `["w1","w2","p5"]` with that fill → one batch of 20 starting with `w1, w2, p5`, no duplicates.
  - 45 watched + 10 other fill → batch sizes `[20, 20, 15]`.
  - 20 watched → one batch of 20, `nextCursor` = cursor passed in.
  - nothing watched, empty fill → `{ batches: [], nextCursor: 0 }`.
  - `jitter(1000, () => 0)` = 800, `() => 1` → 1200, `() => 0.5` → 1000.
  - gate with fake clock and `random = () => 0.5`: five `reportFailure("blocked")` → `backoffUntil − now` = 90 000, 180 000, 300 000, 600 000, 600 000; errors → 30 000, 60 000, 120 000, 300 000, 300 000; `blocked, blocked, error` → last delay 30 000; `isOpen()` false until the clock passes `backoffUntil`; `reportSuccess()` → open, `backoffUntil` null, `consecutiveFailures` 0, `lastFailure` kept for display; `requestsLastHour()` drops requests older than 3 600 s.
- [ ] **Step 2: Run** → FAIL. **Step 3: Implement.** **Step 4: Run** `npx vitest run test/core` → PASS.
- [ ] **Step 5: Commit** `feat: batch planning and Apple backoff gate`.

---

### Task 5: Catalog parsing, catalog service, custom parts

**Files:**
- Create: `src/apple/catalog.ts`, `src/core/catalog-service.ts`
- Test: `test/apple/catalog.test.ts`, `test/core/catalog-service.test.ts`

**Interfaces:**
- Consumes: `AppleClient`, `BatchResult`, `CatalogItem` (Task 2); `Repo` (Task 3); `AppleGate` (Task 4); `Clock`.
- Produces (`src/apple/catalog.ts`): `parseModelSlugs(html: string): string[]` (unique, first-appearance order, only `iphone-*`); `familyFromSlug(slug: string): string`; `parseTitle(title: string): { modelName: string; capacityLabel: string; colorLabel: string }` (regex `^(.*?)\s(\d+\s?(?:GB|TB))\s(.+)$`, fallback whole title / `""` / `""`); `parseLocatorMeta(json: unknown, family: string, sortOrder: number): CatalogItem[] | null` (null when `body.productLocatorOverlayData.productLocatorMeta.products` is missing; price `"1999_00"` → 1999); `imageUrl(imageKey: string): string`; `buyLink(partNumber: string): string`; `normalizePartNumber(input: string): string | null` (trim, upper-case, `^[A-Z0-9]{4,7}[A-Z]{0,3}\/A$`).
- Produces (`src/core/catalog-service.ts`):
  - `class CatalogService { constructor(deps: { apple: AppleClient; repo: Repo; gate: AppleGate; clock: Clock; sleep?: (ms: number) => Promise<void>; spacingMs?: number /* 2500 */ }); refresh(): Promise<{ ok: boolean; families: { family: string; count: number | null }[] }>; refreshIfStale(maxAgeMs: number): Promise<void>; lookupCustomPart(partNumber: string, location: string): Promise<CustomLookup> }`
  - `type CustomLookup = { kind: "added"; partNumber: string; title: string } | { kind: "invalid" } | { kind: "unknown" } | { kind: "backoff" } | { kind: "error"; message: string }`
  - setting key `catalog_refreshed_at` (ms as string).

Refresh: gate closed → `{ ok: false, families: [] }`, no request. `GET buy-iphone` → slugs → for each family (sortOrder = slug index), `sleep(spacingMs)` between requests, `GET product-locator-meta?family=<f>`. `blocked` → `gate.reportFailure("blocked", …)` and stop. A `null` parse or `error` → that family `count: null`, its rows untouched. Successful family → `upsertCatalogItems` + `deactivateMissing(family, parts)`. Dedupe parts across families (first family wins). `ok` = at least one family succeeded; only then set `catalog_refreshed_at`. No slugs → `ok: false`, nothing changed. `refreshIfStale`: refresh when no active non-custom items or `now − catalog_refreshed_at ≥ maxAgeMs`.

Custom lookup: `normalizePartNumber` null → `invalid` (no request); gate closed → `backoff`; else `countRequest`, `apple.pickup([part], location)`: success containing the part → `repo.addCustomPart(part, productTitle || part, now)` → `added`; success without it, or `empty` → `unknown`; `blocked` → `gate.reportFailure("blocked", …)`, return `backoff`; `error` → `error` (gate not touched).

- [ ] **Step 1: Write failing tests**
  - `parseModelSlugs(buy-iphone-index.html)` = `["iphone-duo", "iphone-18-pro", "iphone-air", "iphone-17", "iphone-17e", "iphone-16"]`; `familyFromSlug("iphone-18-pro")` = `"iphone18pro"`.
  - `parseTitle("iPhone 18 Pro Max 1 TB Schwarz")` → `{ modelName: "iPhone 18 Pro Max", capacityLabel: "1 TB", colorLabel: "Schwarz" }`; `"iPhone 16 128 GB Weiß"` → `"iPhone 16"`, `"128 GB"`, `"Weiß"`; `"AirPods Pro 3"` → `{ modelName: "AirPods Pro 3", capacityLabel: "", colorLabel: "" }`.
  - `parseLocatorMeta(duoFixture, "iphoneduo", 0)` has 8 items; `MK2D4QL/A` → `{ title: "iPhone Duo 256 GB Sternenweiß", modelName: "iPhone Duo", colorKey: "starwhite", colorLabel: "Sternenweiß", capacityKey: "256gb", capacityLabel: "256 GB", priceChf: 1999, imageKey: "iphone-duo-finish-select-star-white-202609", productLink: "https://www.apple.com/ch-de/shop/buy-iphone/iphone-duo/7,6%E2%80%9D-display-256gb-sternenwei%C3%9F", screensizeKey: null }`.
  - 18 Pro fixture → 32 items, model names `{"iPhone 18 Pro", "iPhone 18 Pro Max"}`; unknown-family fixture → `null`.
  - `normalizePartNumber(" mk2d4ql/a ")` = `"MK2D4QL/A"`; `"MXP63ZM/A"` ok; `"hello"`, `""`, `"MK2D4QL"` → null.
  - service with a fake `AppleClient.get` serving fixtures by path: full refresh → 73 active items, `ok: true`, setting set, `sleep` called with 2500 between family requests; same refresh where `iphoneair` returns the unknown-family JSON and the repo was pre-seeded with one `iphoneair` item → that item still active, family `count: null`; `blocked` on the 3rd family → `gate.isOpen()` false and no further `get` calls; gate closed → no `get` calls.
  - `refreshIfStale`: fresh repo → refreshes; refreshed 1 h ago with 24 h max → no request.
  - `lookupCustomPart`: `"nope"` → `invalid` with zero requests; fake pickup success (single-store fixture, part `MK2D4QL/A`) → `added` with the fixture's title, catalog row `isCustom`; `empty` → `unknown`; `blocked` → `backoff` and gate closed; gate closed beforehand → `backoff` with zero requests.
- [ ] **Step 2: Run** → FAIL. **Step 3: Implement.** **Step 4: Run** `npx vitest run test/apple test/core` → PASS.
- [ ] **Step 5: Commit** `feat: catalog discovery and custom part lookup`.

---

### Task 6: State updates and alert evaluation

**Files:**
- Create: `src/core/evaluate.ts`
- Test: `test/core/evaluate.test.ts`

**Interfaces:**
- Consumes: `Observation`, `PickupStatus` (Task 2); `Repo`, `Alert`, `HitRow` (Task 3).
- Produces:
  - `interface StateChange { partNumber: string; storeNumber: string; from: PickupStatus; to: PickupStatus }`
  - `applyObservations(repo: Repo, observations: Observation[], now: number): StateChange[]` — upserts availability (lastCheckedAt = now; lastChangedAt = now only on change or first sighting); on change inserts event `restock` (→ available) / `soldout` (→ unavailable). First sighting: no event, no change.
  - `interface AlertMatch { alert: Alert; observations: Observation[] }`
  - `evaluateAlerts(repo: Repo, observations: Observation[], now: number, cooldownMs: number): AlertMatch[]` — per enabled alert, per observation whose part and store are both in the alert: `unavailable` → hit inactive; `available` and hit not active → if `lastNotifiedAt` is set and `now − lastNotifiedAt < cooldownMs`, set hit active without pushing; otherwise include in the match. Pairs without an observation are untouched. One match per alert with ≥1 observation.
  - `markNotified(repo: Repo, match: AlertMatch, now: number): void` — hits active, `lastNotifiedAt = now`.

- [ ] **Step 1: Write failing tests** (observation factory `obs(part, store, status)`; cooldown 10 min):
  - first sighting → `[]` changes, row exists with `lastChangedAt === now`; `unavailable → available` → one change + one `restock` event; `available → unavailable` → `soldout`; same status later → `lastCheckedAt` updated, `lastChangedAt` unchanged, no event.
  - alert `[A]` × `[R159, R309]`: `A@R159 available` → 1 match with that observation; after `markNotified`, same observation → `[]`.
  - ignored: store not in the alert, part not in the alert, disabled alert.
  - re-arm: notified at t0, `unavailable` at t0+1 min, `available` at t0+20 min → match.
  - cooldown: notified at t0, `unavailable` at t0+1 min, `available` at t0+3 min → `[]` and hit active; `unavailable` at t0+20, `available` at t0+21 → match.
  - two pairs of one alert available in one call → one match with 2 observations; two alerts on the same pair → 2 matches.
  - a call without an observation for a notified pair leaves the hit active.
- [ ] **Step 2: Run** → FAIL. **Step 3: Implement.** **Step 4: Run** `npx vitest run test/core/evaluate.test.ts` → PASS.
- [ ] **Step 5: Commit** `feat: availability state tracking and alert evaluation`.

---

### Task 7: ntfy messages, sender, topic

**Files:**
- Create: `src/notify/ntfy.ts`, `src/notify/topic.ts`
- Test: `test/notify/ntfy.test.ts`, `test/notify/topic.test.ts`

**Interfaces:**
- Consumes: `AlertMatch` (Task 6), `CatalogRow`, `Repo` (Task 3), `StoreInfo`, `imageUrl`, `buyLink` (Task 5), `formatTime`, `formatDuration` (Task 1), `Config`.
- Produces:
  - `interface NtfyAction { action: "view"; label: string; url: string }`
  - `interface NtfyMessage { topic: string; title: string; message: string; priority: 1 | 2 | 3 | 4 | 5; tags: string[]; click?: string; actions?: NtfyAction[]; attach?: string }`
  - `interface Lookup { item(partNumber: string): CatalogRow | undefined; store(storeNumber: string): StoreInfo | undefined }`
  - `buildRestockMessage(topic: string, match: AlertMatch, lookup: Lookup): NtfyMessage`
  - `type HealthEvent = { kind: "degraded"; since: number; reason: string } | { kind: "recovered"; downMs: number } | { kind: "resumed"; pausedMs: number }`
  - `buildHealthMessage(topic: string, event: HealthEvent): NtfyMessage`, `buildTestMessage(topic: string): NtfyMessage`
  - `type SendResult = { ok: true } | { ok: false; error: string }`; `interface Notifier { send(msg: NtfyMessage): Promise<SendResult> }`
  - `createNtfyNotifier(opts: { server: string; token: string | null; fetch?: typeof fetch; timeoutMs?: number /* 10000 */ }): Notifier`
  - `generateTopic(randomBytes?: (n: number) => Uint8Array): string` → `"apple-ch-"` + 24 chars from `abcdefghijklmnopqrstuvwxyz234567`
  - `resolveTopic(config: Config, repo: Repo): string` — `config.ntfyTopic` ?? setting `ntfy_topic` ?? generate and persist to `ntfy_topic`.

Copy rules (exact): group observations by part, keep order. Part title = catalog `title` ?? observation `productTitle` || part number. Link = catalog `productLink` ?? `buyLink(part)`. Store label = `"<name> (<city>)"` or the store number if unknown. Quote = first observation's `quote`.
- One part: `title: "<part title> available"`, `message: "<store labels joined ', '> — <quote>"`, `attach: imageUrl(imageKey)` when the catalog row has an image key, `actions: [{ action: "view", label: "Buy now", url: link }]`.
- Several parts: `title: "<n> configs available"` + `" · <alert name>"` when named; `message` = one line per part `"<part title>: <stores> — <quote>"`; actions for the first 2 parts with label `"Buy <capacityLabel> <colorLabel>"` (trimmed; `"Buy"` if both empty); no attach.
- Always `priority: 5`, `tags: ["iphone"]`, `click` = link of the first part.
- Health: degraded → title `"Stock checker can't reach Apple"`, message `"Failing since <HH:MM> (<reason>). Backing off and retrying."`, priority 3, tags `["warning"]`; recovered → `"Stock checker recovered"`, `"Checking again after <duration> of failures."`, priority 2, `["white_check_mark"]`; resumed → `"Stock checker resumed"`, `"Checking resumed after a <duration> pause (Mac was asleep or the checker wasn't running)."`, priority 2, `["zzz"]`.
- Test: `"Test notification"`, `"ntfy is set up — restock alerts will arrive here."`, priority 3, `["iphone"]`.
- Sender: `POST <server>/` with the JSON message, `Content-Type: application/json`, `Authorization: Bearer <token>` when set; non-2xx → `{ ok: false, error: "HTTP <status>: <first 200 chars of body>" }`; rejection/timeout → `{ ok: false, error: <message> }`.

- [ ] **Step 1: Write failing tests**
  - single part with a Duo catalog row (`MK2D4QL/A`) available at R159 and R309 → exact object: title `"iPhone Duo 256 GB Sternenweiß available"`, message `"Rennweg (Zürich), Glattzentrum (Wallisellen) — Verfügbar Heute"`, click = the row's productLink, attach = `imageUrl("iphone-duo-finish-select-star-white-202609")`, one `"Buy now"` action.
  - two parts in a match for an alert named `"Duo"` → title `"2 configs available · Duo"`, two message lines, two actions labelled `"Buy 256 GB Sternenweiß"`, `"Buy 256 GB Nachthimmel"`, no attach.
  - **missing catalog row** (Review Focus 2): title from the observation's `productTitle`, click `"https://www.apple.com/ch-de/shop/product/MK2D4QL/A"`, no attach; unknown store → store number shown.
  - health messages exact strings; degraded with `since = Date.UTC(2026, 9, 28, 13, 5)` and reason `"blocked, HTTP 541"` → `"Failing since 14:05 (blocked, HTTP 541). Backing off and retrying."`.
  - sender: fake fetch receives `https://ntfy.sh/`, method POST, JSON body equal to the message, auth header only when a token is given; 429 with body `"limit"` → `{ ok: false, error: "HTTP 429: limit" }`; rejection → ok false.
  - `generateTopic(() => new Uint8Array(24))` = `"apple-ch-aaaaaaaaaaaaaaaaaaaaaaaa"`; default matches `/^apple-ch-[a-z2-7]{24}$/`.
  - `resolveTopic`: config topic wins and is not persisted; otherwise generated once and stable across calls/new Repo on the same DB.
- [ ] **Step 2: Run** → FAIL. **Step 3: Implement.** **Step 4: Run** `npx vitest run test/notify` → PASS.
- [ ] **Step 5: Commit** `feat: ntfy notifications`.

---

### Task 8: Health monitor

**Files:**
- Create: `src/core/health.ts`
- Test: `test/core/health.test.ts`

**Interfaces:**
- Consumes: `Repo` (settings), `HealthEvent` (Task 7).
- Produces:
  - `type CycleOutcome = { kind: "success" } | { kind: "blocked"; message: string } | { kind: "error"; message: string }`
  - `class HealthMonitor { constructor(deps: { repo: Repo; healthAfterMs: number; pauseAfterMs: number }); checkPause(now: number): HealthEvent | null; recordCycle(outcome: CycleOutcome, now: number): HealthEvent | null; snapshot(): { failingSince: number | null; degradedSent: boolean; lastSuccessAt: number | null; lastCycleAt: number | null } }`
  - Settings: `last_cycle_at`, `last_success_at` (persisted; read in the constructor).

Rules: `checkPause` → if `last_cycle_at` exists and `now − last_cycle_at ≥ pauseAfterMs`, return `resumed { pausedMs }`, reset `failingSince` to null (keep `degradedSent`), and set `last_cycle_at = now` so the same pause is not reported twice. `recordCycle` → set `last_cycle_at`; success: set `last_success_at`, return `recovered { downMs: now − failingSince }` if `degradedSent`, then clear both; failure: `failingSince ??= now`; if not `degradedSent` and `now − failingSince ≥ healthAfterMs` → `degraded { since: failingSince, reason: message }`, `degradedSent = true`.

- [ ] **Step 1: Write failing tests** (healthAfter 15 min, pauseAfter 30 min):
  - failures at t0, +5 min, +14 min → null; +15 min → `degraded { since: t0, reason: "blocked, HTTP 541" }`; +16 min → null; success at +20 min → `recovered { downMs: 20 min }`; next success → null.
  - failure then success within 15 min → no event.
  - `last_cycle_at = t0`: `checkPause(t0 + 29 min)` → null; `checkPause(t0 + 6 h)` → `resumed { pausedMs: 6 h }`; calling again immediately → null.
  - streak across a pause: failure at t0; `checkPause(t0 + 6 h)` → resumed; failure at t0 + 6 h → null; failure at t0 + 6 h + 15 min → `degraded { since: t0 + 6 h }`.
  - fresh repo `checkPause` → null; `recordCycle` persists `last_cycle_at` (a new monitor on the same repo sees it in `snapshot()`).
- [ ] **Step 2: Run** → FAIL. **Step 3: Implement.** **Step 4: Run** → PASS.
- [ ] **Step 5: Commit** `feat: health monitor for failures and pauses`.

---

### Task 9: Checker (cycle orchestration and loop)

**Files:**
- Create: `src/core/checker.ts`
- Test: `test/core/checker.test.ts`

**Interfaces:**
- Consumes: everything from Tasks 2–8.
- Produces:
  - `interface CheckerDeps { repo: Repo; apple: AppleClient; gate: AppleGate; notifier: Notifier; health: HealthMonitor; catalog: CatalogService; clock: Clock; config: Config; topic: string; random?: () => number; sleep?: (ms: number) => Promise<void>; fetch?: typeof fetch }`
  - `interface CycleReport { outcome: CycleOutcome | { kind: "skipped" }; requests: number; observations: number; changes: StateChange[]; pushes: number }`
  - `interface CheckerStatus { state: "starting" | "ok" | "blocked" | "error"; lastSuccessAt: number | null; lastCycleAt: number | null; backoffUntil: number | null; lastFailure: { kind: FailureKind; message: string; at: number } | null; failingSince: number | null; requestsLastHour: number; nextRunAt: number | null; watchedParts: number }`
  - `class Checker { constructor(deps: CheckerDeps); runCycle(): Promise<CycleReport>; nextDelayMs(): number; start(): void; stop(): void; status(): CheckerStatus }`

`runCycle`:
1. `health.checkPause(now)` → if an event, send `buildHealthMessage` and log it (`kind: "health"`).
2. Gate closed → return `skipped` (no health record).
3. `planBatches(repo.watchedParts(), active catalog part numbers, cursor)`; keep `nextCursor`. No batches → `skipped`.
4. For each batch (between batches `sleep(2000 + random() * 2000)`): `gate.countRequest()`, `apple.pickup(batch, config.appleLocation)`.
   - `success` → log a `stores.missing` warning when it has fewer stores than `repo.listStores()`, `repo.upsertStores`, `applyObservations`, `evaluateAlerts(…, renotifyCooldownMinutes)`, for each match `notifier.send(buildRestockMessage(topic, match, lookup))`, log it (`kind: "restock"`), `markNotified` only when ok. Log each state change.
   - `empty` → log a warning with the message; continue.
   - `blocked` → `gate.reportFailure("blocked", "HTTP <status>")`, outcome `{ kind: "blocked", message: "blocked, HTTP <status>" }`, stop the cycle.
   - `error` → `gate.reportFailure("error", message)`, outcome `error`, stop.
5. No blocked/error: any success → `gate.reportSuccess()`, outcome success; all empty → `gate.reportFailure("error", "Apple returned no store data")`, outcome error.
6. `health.recordCycle(outcome, now)` → push the event if any.
7. On success with `config.heartbeatUrl` and ≥ 5 min since the last ping: fire-and-forget `fetch(heartbeatUrl)`, errors only logged.

`nextDelayMs`: if `gate.backoffUntil > now` → `backoffUntil − now`; else `jitter(max(pollIntervalSeconds, ceil(max(1, ceil(watched/20)) × 3600 / maxRequestsPerHour)) × 1000, random)`.
`start`: one async loop, never concurrent: `catalog.refreshIfStale(24 h)` (errors logged), `runCycle()` (unexpected exceptions logged, loop continues), then wait `nextDelayMs()`; log `loop.gap` when the actual wake-up is > 60 s late. `stop` clears the timer and ends the loop. `status().state`: `starting` before the first cycle, `blocked`/`error` while `gate.consecutiveFailures > 0` (by `lastFailure.kind`), else `ok`.

- [ ] **Step 1: Write failing integration tests** (in-memory repo seeded with the 8 Duo catalog items via `parseLocatorMeta`, fake `AppleClient` with a queue of `BatchResult`s that records the requested parts, fake notifier recording messages with programmable failures, fake clock, `sleep` no-op, `random = () => 0.5`):
  - alert `[MK2D4QL/A]` × all stores: cycle with it `unavailable` everywhere → 0 pushes; next cycle `available` at R159 → exactly 1 push titled `"iPhone Duo 256 GB Sternenweiß available"`; third cycle still available → 0 pushes.
  - **restart** (Review Focus 3): after the push, a new `Checker` (new gate/health, same repo) sees it still available → 0 pushes.
  - ntfy fails on the first attempt → no hit; next cycle pushes once; the cycle after → 0. Two notification log rows (ok false, ok true).
  - 21 watched custom parts, first batch answers `{ kind: "blocked", httpStatus: 541 }` → only 1 request, availability unchanged, `nextDelayMs()` = 90 000, report outcome blocked.
  - all-`empty` cycle → outcome error and gate closed; `empty` + `success` in one cycle (21 watched) → success.
  - blocked cycles every 2 min (advance the clock past `backoffUntil` each time) for 16 min → exactly one degraded push; then a success → exactly one recovered push.
  - persisted `last_cycle_at` 6 h ago → first cycle sends one `"Stock checker resumed"` push and no degraded push.
  - `nextDelayMs()` with 45 watched parts → 72 000; with 3 watched → 30 000.
  - spare slots: alert on 1 part, 73-item catalog → over 4 cycles the requested parts cover every catalog part (seed the full catalog from all six fixtures).
  - heartbeat: `heartbeatUrl` set, successes at t0, +1 min, +6 min → fake fetch called at t0 and +6 min only.
- [ ] **Step 2: Run** `npx vitest run test/core/checker.test.ts` → FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `npx vitest run` → all PASS.
- [ ] **Step 5: Commit** `feat: checker loop with alerts, backoff and health pushes`.

---

### Task 10: Web foundation, layout, settings page

**Files:**
- Create: `src/web/app.tsx`, `src/web/layout.tsx`, `src/web/pages/settings.tsx`, `public/styles.css`
- Test: `test/web/helpers.ts`, `test/web/settings.test.tsx`

**Interfaces:**
- Consumes: `Repo`, `Checker.status()`, `CatalogService`, `Notifier`, `buildTestMessage`, `Config`, `Clock`, time helpers.
- Produces:
  - `interface WebDeps { repo: Repo; checker: { status(): CheckerStatus }; catalog: Pick<CatalogService, "refresh" | "lookupCustomPart">; notifier: Notifier; config: Config; topic: string; clock: Clock }`
  - `createApp(deps: WebDeps): Hono`
  - `Layout({ title, active, flash, now, status, children })` — header with nav (Alerts `/`, Live stock `/stock`, Restocks `/restocks`, Settings `/settings`), health pill, flash banner; loads `/static/styles.css` and `/static/htmx.min.js`.
  - `HealthPill({ status, now })` — `ok`: `"Checking · last success 12 s ago"`; `blocked`: `"Blocked by Apple · retry HH:MM"`; `error`: `"Error · retry HH:MM"` (no time if no backoff); `starting`: `"Starting…"`. Wrapper has `hx-get="/partials/health" hx-trigger="every 10s" hx-swap="outerHTML"`.
  - `test/web/helpers.ts`: `makeTestApp(overrides?)` → `{ app, repo, notifier, catalog, clock, setStatus }` with in-memory repo and fakes.

Routes in this task: `GET /static/styles.css` (from `public/`), `GET /static/htmx.min.js` (from `node_modules/htmx.org/dist/htmx.min.js`), `GET /partials/health`, `GET /settings`, `POST /settings/test-notification`, `POST /settings/refresh-catalog`, `GET /api/status`. Resolve `public/` and `node_modules/` relative to the project root via `import.meta.url` so it works from `src/` and `dist/`. Flash messages travel as `?flash=` on 303 redirects. Settings page shows: ntfy server, topic, subscribe URL `<server>/<topic>` as a link, QR code (`qrcode.toString(url, { type: "svg" })`), test button; poll settings (interval, budget, location); health details (state, last success, last failure, backoff until, requests last hour, failing since); catalog (last refreshed, active item count, refresh button); last 20 notifications. `POST /settings/refresh-catalog` starts `catalog.refresh()` without awaiting (errors logged) and redirects with `"Catalog refresh started"`.

Visual design: clean neutral system-font UI, CSS variables with light/dark via `prefers-color-scheme`, max-width container, readable at phone width; status colours green / grey / hatched. Details are the builder's.

- [ ] **Step 1: Write failing tests** (`app.request()`):
  - `GET /settings` → 200, contains the topic, `https://ntfy.sh/<topic>`, and `<svg`.
  - `POST /settings/test-notification` → notifier received `buildTestMessage(topic)`; 303 to `/settings?flash=…` with "sent"; notifier failure → flash contains the error.
  - `GET /partials/health` with status `blocked`, `backoffUntil = Date.UTC(2026, 9, 28, 13, 12)` → contains `"Blocked by Apple"` and `"14:12"`; with `ok` and lastSuccess 12 s ago → `"last success 12 s ago"`.
  - `GET /static/htmx.min.js` → 200 with a JavaScript content type; `GET /static/styles.css` → 200.
  - `GET /api/status` → JSON equal to the fake status.
- [ ] **Step 2: Run** → FAIL. **Step 3: Implement.** **Step 4: Run** `npx vitest run test/web` → PASS.
- [ ] **Step 5: Commit** `feat: dashboard layout and settings page`.

---

### Task 11: Alerts pages

**Files:**
- Create: `src/web/pages/alerts.tsx`, `src/web/pages/new-alert.tsx`
- Modify: `src/web/app.tsx`
- Test: `test/web/alerts.test.tsx`

**Interfaces:**
- Consumes: `WebDeps`, `Repo` alerts/catalog/availability/hits, `CustomLookup` (Task 5).
- Produces routes: `GET /`, `GET /alerts/new` (`?model=<modelName>`), `POST /alerts`, `POST /alerts/custom`, `POST /alerts/:id/toggle`, `POST /alerts/:id/delete`.

Behaviour:
- `/`: empty state `"No alerts yet"` + link to `/alerts/new`. Each alert: display name (name ?? part titles joined `", "`), status matrix parts × alert stores with dot classes `available` / `unavailable` / `nodata` / `stale` (last check > 10 min old) and Apple's quote as tooltip, `"Last pushed <ago>"` from `listHits` (or `"Never pushed"`), enable/disable and delete buttons (forms). Part title falls back to an availability row's `productTitle`, then the part number (Review Focus 2). Warning `"Apple returns no data for this part"` when the alert is ≥ 30 min old, the checker had a success in the last 5 min, and none of the part's availability rows was checked in the last 30 min.
- `/alerts/new`: list of model names from the active catalog (catalog order) as links; with `?model=`, a form posting to `/alerts`: checkbox grid rows = capacities (ascending by GB, TB = 1024 GB), columns = colours (first-appearance order), checkbox `name="part" value="<partNumber>"`; store checkboxes `name="store"` (all checked by default); optional `name`. Below, a second form posting to `/alerts/custom`: `partNumber` text, store checkboxes, optional name. No active catalog yet → `"Catalog is still loading — refresh in a minute"`.
- `POST /alerts`: multi-value `part`/`store` (`c.req.parseBody({ all: true })`). Errors re-render the form with status 400: no part → `"Pick at least one configuration"`; no store → `"Pick at least one store"`; part not an active catalog item or store not in `listStores()` → `"Unknown configuration or store"`. Success → `createAlert`, 303 to `/?flash=Alert created`.
- `POST /alerts/custom`: validate stores as above, then `catalog.lookupCustomPart(partNumber, config.appleLocation)`: `added` → create alert, 303 `/?flash=Alert created for <title>`; `invalid` → 400 `"That doesn't look like an Apple part number (e.g. MK2D4QL/A)"`; `unknown` → 400 `"Apple doesn't know this part for Switzerland"`; `backoff` → 503 `"Apple is rate-limiting us right now — try again in a few minutes"`; `error` → 502 with the message.
- Toggle/delete → 303 to `/` with a flash.

- [ ] **Step 1: Write failing tests**
  - `GET /` empty → contains `"No alerts yet"`.
  - `GET /alerts/new` (catalog seeded from all six fixtures) contains `"iPhone Duo"` and `"iPhone 18 Pro Max"`; `?model=iPhone%20Duo` → exactly 8 `name="part"` checkboxes incl. `value="MK2D4QL/A"` and 4 checked store boxes.
  - `POST /alerts` with `part=MK2D4QL/A&part=MK2E4QL/A&store=R159&store=R309` → 303, `listAlerts()[0]` has those parts and stores.
  - Review Focus 4: no `part` → 400 with `"Pick at least one configuration"`; no `store` → 400 `"Pick at least one store"`; `part=FAKE1QL/A` → 400 `"Unknown configuration or store"`; nothing created in all three.
  - Review Focus 2: an alert on `ZZZZ1QL/A` (no catalog row, no availability) renders on `/` showing `"ZZZZ1QL/A"` with status 200.
  - `/` shows an `available` dot when availability says available, and `"Last pushed"` after a hit with `lastNotifiedAt`.
  - toggle flips `enabled`; delete removes the alert.
  - custom: fake `lookupCustomPart` returning each `CustomLookup` kind → statuses 303/400/400/503/502 and messages above; `added` creates the alert.
- [ ] **Step 2: Run** → FAIL. **Step 3: Implement.** **Step 4: Run** `npx vitest run test/web` → PASS.
- [ ] **Step 5: Commit** `feat: alert management pages`.

---

### Task 12: Live stock and restocks pages

**Files:**
- Create: `src/web/pages/stock.tsx`, `src/web/pages/restocks.tsx`, `src/core/restocks.ts`
- Modify: `src/web/app.tsx`
- Test: `test/web/stock.test.tsx`, `test/core/restocks.test.ts`

**Interfaces:**
- Consumes: `Repo.listCatalog/listStores/listAvailability/listEvents`, time helpers.
- Produces: `GET /stock`, `GET /partials/stock`, `GET /restocks`; `pairRestockDurations(events: EventRow[]): Map<number, number | null>` (restock event id → ms until the next `soldout` of the same pair, `null` if none yet; input in any order).

Behaviour:
- `/stock`: summary `"<x> of <y> configurations available somewhere"`; one section per model (catalog order, Custom last); table rows sorted by capacity (GB) then colour label; row label `"<colorLabel> · <capacityLabel>"` (custom: title) and price `"CHF 1999"` when known; columns = `listStores()` headers `"<name>"` with city below; cell class `available` / `unavailable` / `nodata`, plus `stale` when `lastCheckedAt` is > 10 min old; cell `title` = `"<quote> · checked <HH:MM>"`. The grid lives in `<div id="stock-grid" hx-get="/partials/stock" hx-trigger="every 15s" hx-swap="outerHTML">`; the partial returns only that div.
- `/restocks`: latest 200 events: `formatDateTime(at)`, product title (catalog → part number), store label, `"Back in stock"` / `"Sold out"`, and for restocks the duration (`formatDuration`) or `"still available"`.

- [ ] **Step 1: Write failing tests**
  - `pairRestockDurations`: restock A@R159 t0, soldout A@R159 t0+23 min, restock A@R309 t0+5 min → `{restock1: 23 min, restock2: null}`; a soldout of another pair doesn't pair.
  - `/stock` with the Duo catalog and availability `MK2D4QL/A@R159 available` (fresh) and `MK2E4QL/A@R159 unavailable` (checked 20 min ago): store headers in order Rennweg, Glattzentrum, Freie Strasse, Rue de Rive; the MK2D4/R159 cell has class `available`; MK2E4/R159 has `unavailable` and `stale`; MK2D4/R309 has `nodata`; summary `"1 of 8 configurations available somewhere"`.
  - `/partials/stock` → contains `id="stock-grid"` and no `<html`.
  - `/restocks` → newest first, shows `"Back in stock"`, `"23 min"` and `"still available"`.
- [ ] **Step 2: Run** → FAIL. **Step 3: Implement.** **Step 4: Run** `npx vitest run` → all PASS.
- [ ] **Step 5: Commit** `feat: live stock grid and restock history`.

---

### Task 13: Wiring, service, smoke test, README, live verification

**Files:**
- Create: `src/main.ts`, `scripts/service.sh`, `scripts/smoke.ts`, `README.md`

**Interfaces:**
- Consumes: everything.

- [ ] **Step 1: `src/main.ts`** — if `.env` exists in `process.cwd()`, `process.loadEnvFile(".env")`; `loadConfig(process.env)`; `openDb(join(dataDir, "stockchecker.db"))`; build `Repo`, `AppleGate(systemClock)`, `createAppleClient()`, `CatalogService`, `HealthMonitor` (minutes → ms), `createNtfyNotifier`, `resolveTopic`, `Checker`, `createApp`; `serve({ fetch: app.fetch, port, hostname: host })`; log `startup` with the dashboard URL and topic; `checker.start()`; on SIGINT/SIGTERM stop the checker, close the server and DB, exit 0.
- [ ] **Step 2: `scripts/service.sh <install|uninstall|restart|logs|status>`** — label `local.apple-stock-ch`, plist `~/Library/LaunchAgents/local.apple-stock-ch.plist`, log `~/Library/Logs/apple-stock-ch.log`. `install`: `npm run build`; node path = `node -p process.execPath`; ProgramArguments `/usr/bin/caffeinate -s <node> --disable-warning=ExperimentalWarning <project>/dist/main.js`; `WorkingDirectory` = project; `RunAtLoad` and `KeepAlive` true; `ThrottleInterval` 30; stdout/stderr → the log; `launchctl bootout` (ignore failure) then `launchctl bootstrap gui/$(id -u) <plist>`. `uninstall`: bootout + remove the plist. `restart`: `launchctl kickstart -k gui/$(id -u)/local.apple-stock-ch`. `logs`: `tail -n 100 -f <log>`. `status`: `launchctl print gui/$(id -u)/local.apple-stock-ch | head -20`.
- [ ] **Step 3: `scripts/smoke.ts`** — real requests: `product-locator-meta?family=iphoneduo` → parse → `pickup(parts, "8001")` → print a part × store table of statuses and the request duration; exit 1 unless the result is `success` with 4 stores. With `--push`: open the real DB (`DATA_DIR`), `resolveTopic`, send `buildTestMessage`, print the result and the subscribe URL.
- [ ] **Step 4: `README.md`** — what it is; requirements; setup (`npm install`, `npm run build`, `npm run service:install`); subscribe (open `http://127.0.0.1:4321/settings`, scan the QR code with the ntfy app or subscribe to the topic); create alerts; config table (from `.env.example`); "Sleep and battery" (caffeinate on AC only, resumed pushes, optional `HEARTBEAT_URL` with healthchecks.io → its ntfy integration); how it works (endpoint, 20-part batches, budget/backoff, SHIELD note with a link to the research doc); troubleshooting (541 blocks, logs, `npm run smoke`); uninstall.
- [ ] **Step 5: Verify** — `npm run typecheck && npm test && npm run build` → all pass; `npm run smoke` → table printed, exit 0; `npm start` in the background with a temp `DATA_DIR`, then `curl -s localhost:4321/`, `/stock`, `/restocks`, `/settings`, `/api/status` all 200; after ~2 cycles `/api/status` shows `state: "ok"` and the log shows `cycle` lines with `requests=1`; catalog has 73 items. Stop it.
- [ ] **Step 6: Commit** `feat: wiring, launchd service, smoke test and README`.
