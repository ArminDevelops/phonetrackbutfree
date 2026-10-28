import { describe, expect, test, vi } from "vitest";
import { loadConfig } from "../../src/config.js";
import { CatalogService } from "../../src/core/catalog-service.js";
import { Checker } from "../../src/core/checker.js";
import { AppleGate } from "../../src/core/gate.js";
import { HealthMonitor } from "../../src/core/health.js";
import { openDb } from "../../src/db/db.js";
import { Repo } from "../../src/db/repo.js";
import type { NtfyMessage, Notifier } from "../../src/notify/ntfy.js";
import { fixtureApple, stock } from "../helpers/apple.js";
import { seedCatalog } from "../helpers/catalog.js";
import { FakeClock } from "../helpers/clock.js";

const MIN = 60_000;
const HOUR = 60 * MIN;
const DUO = "MK2D4QL/A";
const ALL_STORES = ["R159", "R309", "R439", "R275"];

function setup(env: Record<string, string> = {}, families = ["iphoneduo"]) {
  const clock = new FakeClock();
  const repo = new Repo(openDb(":memory:"));
  seedCatalog(repo, families);
  repo.setSetting("catalog_refreshed_at", String(clock.now()));
  const apple = fixtureApple();
  const sent: NtfyMessage[] = [];
  let failures = 0;
  const notifier: Notifier = {
    async send(msg) {
      if (failures > 0) {
        failures--;
        return { ok: false, error: "HTTP 500: down" };
      }
      sent.push(msg);
      return { ok: true };
    },
  };
  const heartbeats: number[] = [];
  const fetch = (async () => {
    heartbeats.push(clock.now());
    return new Response("ok");
  }) as unknown as typeof globalThis.fetch;
  const config = loadConfig(env);

  function make() {
    const gate = new AppleGate(clock, () => 0.5);
    const health = new HealthMonitor({ repo, healthAfterMs: 15 * MIN, pauseAfterMs: 30 * MIN });
    const catalog = new CatalogService({ apple: apple.client, repo, gate, clock, sleep: async () => {} });
    const checker = new Checker({
      repo,
      apple: apple.client,
      gate,
      notifier,
      health,
      catalog,
      clock,
      config,
      topic: "apple-ch-test",
      random: () => 0.5,
      sleep: async () => {},
      fetch,
    });
    return { checker, gate };
  }

  return {
    clock,
    repo,
    apple,
    sent,
    heartbeats,
    make,
    failNextPushes(n: number) {
      failures = n;
    },
  };
}

describe("restock pushes", () => {
  test("exactly one push when a watched part becomes available", async () => {
    const s = setup();
    s.repo.createAlert({ name: null, partNumbers: [DUO], storeNumbers: ALL_STORES }, s.clock.now());
    let available: Record<string, string[]> = {};
    s.apple.onPickup((parts) => stock(parts, available));
    const { checker } = s.make();

    expect((await checker.runCycle()).pushes).toBe(0);
    available = { [DUO]: ["R159"] };
    s.clock.advance(30_000);
    const report = await checker.runCycle();
    expect(report.pushes).toBe(1);
    expect(report.changes).toEqual([{ partNumber: DUO, storeNumber: "R159", from: "unavailable", to: "available" }]);
    expect(s.sent.map((m) => m.title)).toEqual(["iPhone Duo 256 GB Sternenweiß available"]);
    s.clock.advance(30_000);
    expect((await checker.runCycle()).pushes).toBe(0);
    expect(s.sent).toHaveLength(1);
  });

  test("a restart does not repeat the push", async () => {
    const s = setup();
    s.repo.createAlert({ name: null, partNumbers: [DUO], storeNumbers: ALL_STORES }, s.clock.now());
    s.apple.onPickup((parts) => stock(parts, { [DUO]: ["R159"] }));
    await s.make().checker.runCycle();
    expect(s.sent).toHaveLength(1);
    s.clock.advance(60_000);
    await s.make().checker.runCycle();
    expect(s.sent).toHaveLength(1);
  });

  test("a failed push is retried on the next cycle, then not again", async () => {
    const s = setup();
    s.repo.createAlert({ name: null, partNumbers: [DUO], storeNumbers: ALL_STORES }, s.clock.now());
    s.apple.onPickup((parts) => stock(parts, { [DUO]: ["R159"] }));
    s.failNextPushes(1);
    const { checker } = s.make();
    await checker.runCycle();
    expect(s.sent).toHaveLength(0);
    s.clock.advance(30_000);
    await checker.runCycle();
    s.clock.advance(30_000);
    await checker.runCycle();
    expect(s.sent).toHaveLength(1);
    expect(s.repo.listNotifications(10).map((n) => n.ok)).toEqual([true, false]);
  });
});

describe("failures", () => {
  const customParts = Array.from({ length: 21 }, (_, i) => `C${String(i).padStart(4, "0")}QL/A`);

  test("a block stops the cycle, changes nothing and backs off", async () => {
    const s = setup();
    s.repo.createAlert({ name: null, partNumbers: customParts, storeNumbers: ALL_STORES }, s.clock.now());
    s.apple.queuePickup({ kind: "blocked", httpStatus: 541 });
    const { checker } = s.make();
    const report = await checker.runCycle();
    expect(report.outcome).toEqual({ kind: "blocked", message: "blocked, HTTP 541" });
    expect(s.apple.pickups).toHaveLength(1);
    expect(s.repo.listAvailability()).toEqual([]);
    expect(checker.nextDelayMs()).toBe(90_000);
    expect(checker.status().state).toBe("blocked");
  });

  test("a cycle where every batch is empty counts as an error", async () => {
    const s = setup();
    s.apple.onPickup(() => ({ kind: "empty" }));
    const { checker, gate } = s.make();
    expect((await checker.runCycle()).outcome).toEqual({ kind: "error", message: "Apple returned no store data" });
    expect(gate.isOpen()).toBe(false);
  });

  test("one empty batch next to a good one is fine", async () => {
    const s = setup();
    s.repo.createAlert({ name: null, partNumbers: customParts, storeNumbers: ALL_STORES }, s.clock.now());
    s.apple.queuePickup({ kind: "empty" });
    s.apple.onPickup((parts) => stock(parts));
    const { checker, gate } = s.make();
    expect((await checker.runCycle()).outcome).toEqual({ kind: "success" });
    expect(s.apple.pickups).toHaveLength(2);
    expect(gate.isOpen()).toBe(true);
  });

  test("an exception during a request counts as an error with backoff", async () => {
    const s = setup();
    s.apple.onPickup(() => {
      throw new Error("boom");
    });
    const { checker, gate } = s.make();
    expect((await checker.runCycle()).outcome).toEqual({ kind: "error", message: "boom" });
    expect(gate.isOpen()).toBe(false);
    expect(checker.status().state).toBe("error");
  });

  test("an unexpected crash inside the loop still backs off and counts as failing", async () => {
    const s = setup();
    s.apple.onPickup((parts) => stock(parts));
    s.repo.upsertStores = () => {
      throw new Error("database is locked");
    };
    const { checker, gate } = s.make();
    checker.start();
    await vi.waitFor(() => expect(gate.isOpen()).toBe(false));
    checker.stop();
    expect(checker.status()).toMatchObject({ state: "error", failingSince: s.clock.now() });
    expect(gate.lastFailure?.message).toContain("database is locked");
  });

  test("no requests while backing off", async () => {
    const s = setup();
    const { checker, gate } = s.make();
    gate.reportFailure("blocked", "HTTP 541");
    expect((await checker.runCycle()).outcome).toEqual({ kind: "skipped" });
    expect(s.apple.pickups).toEqual([]);
  });
});

describe("health pushes", () => {
  test("15 minutes of blocks give one warning, recovery gives one all-clear", async () => {
    const s = setup();
    let blocked = true;
    s.apple.onPickup((parts) => (blocked ? { kind: "blocked", httpStatus: 541 } : stock(parts)));
    const { checker, gate } = s.make();
    // Blocked cycles at 0, 1.5, 4.5, 9.5, 19.5 and 34.5 min (each waits out its backoff).
    for (let i = 0; i < 6; i++) {
      await checker.runCycle();
      s.clock.t = gate.backoffUntil!;
    }
    expect(s.sent.map((m) => m.title)).toEqual(["Stock checker can't reach Apple"]);
    blocked = false;
    await checker.runCycle();
    expect(s.sent.map((m) => m.title)).toEqual(["Stock checker can't reach Apple", "Stock checker recovered"]);
  });

  test("a health push that ntfy rejects is retried on the next cycle", async () => {
    const s = setup();
    s.repo.setSetting("last_cycle_at", String(s.clock.now() - 6 * HOUR));
    s.apple.onPickup((parts) => stock(parts));
    s.failNextPushes(1);
    const { checker } = s.make();
    await checker.runCycle();
    expect(s.sent).toEqual([]);
    s.clock.advance(30_000);
    await checker.runCycle();
    s.clock.advance(30_000);
    await checker.runCycle();
    expect(s.sent.map((m) => m.title)).toEqual(["Stock checker resumed"]);
  });

  test("a long pause gives one resumed push and no warning", async () => {
    const s = setup();
    s.repo.setSetting("last_cycle_at", String(s.clock.now() - 6 * HOUR));
    s.apple.onPickup((parts) => stock(parts));
    await s.make().checker.runCycle();
    expect(s.sent.map((m) => m.title)).toEqual(["Stock checker resumed"]);
    expect(s.sent[0]!.message).toContain("6 h");
  });
});

describe("sleep in the middle of a cycle", () => {
  test("a pause during a request is reported and not counted as failure time", async () => {
    const s = setup();
    let sleepNow = false;
    s.apple.onPickup(() => {
      if (sleepNow) s.clock.advance(6 * HOUR);
      return { kind: "error", message: "timeout after 15000 ms" };
    });
    const { checker, gate } = s.make();
    await checker.runCycle();
    s.clock.t = gate.backoffUntil!;
    sleepNow = true;
    await checker.runCycle();
    expect(s.sent.map((m) => m.title)).toEqual(["Stock checker resumed"]);
    expect(checker.status().failingSince).toBe(s.clock.now());
  });
});

describe("scheduling", () => {
  test("the interval stretches to respect the hourly budget", () => {
    const s = setup();
    const watched = (n: number) => Array.from({ length: n }, (_, i) => `W${String(i).padStart(4, "0")}QL/A`);
    s.repo.createAlert({ name: null, partNumbers: watched(3), storeNumbers: ALL_STORES }, s.clock.now());
    expect(s.make().checker.nextDelayMs()).toBe(90_000);
    // 48 watched parts → 3 requests per cycle; 45 requests/hour → one cycle every 240 s.
    s.repo.createAlert({ name: null, partNumbers: watched(45), storeNumbers: ALL_STORES }, s.clock.now());
    expect(s.make().checker.nextDelayMs()).toBe(240_000);
  });

  test("spare slots sweep the whole catalog", async () => {
    const s = setup({}, ["iphoneduo", "iphone18pro", "iphoneair", "iphone17", "iphone17e", "iphone16"]);
    s.repo.createAlert({ name: null, partNumbers: [DUO], storeNumbers: ALL_STORES }, s.clock.now());
    s.apple.onPickup((parts) => stock(parts));
    const { checker } = s.make();
    for (let i = 0; i < 4; i++) {
      await checker.runCycle();
      s.clock.advance(30_000);
    }
    expect(s.apple.pickups.every((batch) => batch[0] === DUO && batch.length === 20)).toBe(true);
    const requested = new Set(s.apple.pickups.flat());
    const catalog = s.repo.listCatalog({ activeOnly: true }).map((i) => i.partNumber);
    expect(catalog).toHaveLength(73);
    expect(catalog.every((p) => requested.has(p))).toBe(true);
  });

  test("heartbeat is pinged at most every 5 minutes", async () => {
    const s = setup({ HEARTBEAT_URL: "https://hc-ping.com/abc" });
    s.apple.onPickup((parts) => stock(parts));
    const { checker } = s.make();
    const t0 = s.clock.now();
    await checker.runCycle();
    s.clock.advance(MIN);
    await checker.runCycle();
    s.clock.advance(5 * MIN);
    await checker.runCycle();
    expect(s.heartbeats).toEqual([t0, t0 + 6 * MIN]);
  });

  test("status before and after the first cycle", async () => {
    const s = setup();
    s.apple.onPickup((parts) => stock(parts));
    const { checker } = s.make();
    expect(checker.status().state).toBe("starting");
    await checker.runCycle();
    expect(checker.status()).toMatchObject({ state: "ok", lastSuccessAt: s.clock.now(), requestsLastHour: 1, watchedParts: 0 });
  });

  test("a block remembered from before a restart shows as blocked, not starting", () => {
    const s = setup();
    const { checker, gate } = s.make();
    gate.reportFailure("blocked", "HTTP 541");
    expect(checker.status().state).toBe("blocked");
  });

  test("start runs a cycle and stop ends the loop", async () => {
    const s = setup();
    s.apple.onPickup((parts) => stock(parts));
    const { checker } = s.make();
    checker.start();
    await vi.waitFor(() => expect(s.apple.pickups).toHaveLength(1));
    checker.stop();
    expect(checker.status().nextRunAt).toBeNull();
  });
});
