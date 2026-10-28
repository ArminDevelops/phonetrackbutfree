import { describe, expect, test } from "vitest";
import type { CatalogItem } from "../../src/apple/types.js";
import { CatalogService } from "../../src/core/catalog-service.js";
import { AppleGate } from "../../src/core/gate.js";
import { openDb } from "../../src/db/db.js";
import { Repo } from "../../src/db/repo.js";
import { fixtureApple, pickupFixture } from "../helpers/apple.js";
import { FakeClock } from "../helpers/clock.js";

function setup(overrides: Parameters<typeof fixtureApple>[0] = {}) {
  const clock = new FakeClock();
  const repo = new Repo(openDb(":memory:"));
  const gate = new AppleGate(clock, () => 0.5);
  const apple = fixtureApple(overrides);
  const sleeps: number[] = [];
  const service = new CatalogService({
    apple: apple.client,
    repo,
    gate,
    clock,
    sleep: async (ms) => {
      sleeps.push(ms);
    },
  });
  return { clock, repo, gate, apple, sleeps, service };
}

const airItem: CatalogItem = {
  partNumber: "MG2U4QL/A",
  family: "iphoneair",
  modelName: "iPhone Air",
  title: "old",
  colorKey: "",
  colorLabel: "",
  capacityKey: "",
  capacityLabel: "",
  screensizeKey: null,
  priceChf: null,
  imageKey: null,
  productLink: "x",
  sortOrder: 2,
};

describe("refresh", () => {
  test("loads all six families", async () => {
    const { repo, service, sleeps, gate, clock } = setup();
    const result = await service.refresh();
    expect(result.ok).toBe(true);
    expect(result.families).toEqual([
      { family: "iphoneduo", count: 8 },
      { family: "iphone18pro", count: 32 },
      { family: "iphoneair", count: 12 },
      { family: "iphone17", count: 10 },
      { family: "iphone17e", count: 6 },
      { family: "iphone16", count: 5 },
    ]);
    expect(repo.listCatalog({ activeOnly: true })).toHaveLength(73);
    expect(repo.getSetting("catalog_refreshed_at")).toBe(String(clock.now()));
    expect(sleeps).toEqual([2500, 2500, 2500, 2500, 2500, 2500]);
    expect(gate.requestsLastHour()).toBe(7);
  });

  test("a family that fails keeps its previous items", async () => {
    const { repo, service } = setup({
      "product-locator-meta?family=iphoneair": { kind: "ok", text: '{"head":{"status":"200"},"body":{"productLocatorOverlayData":{}}}' },
    });
    repo.upsertCatalogItems([airItem], 0);
    const result = await service.refresh();
    expect(result.families.find((f) => f.family === "iphoneair")).toEqual({ family: "iphoneair", count: null });
    expect(repo.getCatalogItem("MG2U4QL/A")).toMatchObject({ active: true, title: "old" });
    expect(result.ok).toBe(true);
  });

  test("a block stops the refresh and closes the gate", async () => {
    const { service, gate, apple } = setup({
      "product-locator-meta?family=iphoneair": { kind: "blocked", httpStatus: 541 },
    });
    await service.refresh();
    expect(gate.isOpen()).toBe(false);
    expect(apple.gets).toEqual([
      "buy-iphone",
      "product-locator-meta?family=iphoneduo",
      "product-locator-meta?family=iphone18pro",
      "product-locator-meta?family=iphoneair",
    ]);
  });

  test("a refresh interrupted by a block is retried once the gate reopens", async () => {
    const { service, repo, apple, clock } = setup({
      "product-locator-meta?family=iphoneair": { kind: "blocked", httpStatus: 541 },
    });
    await service.refresh();
    expect(repo.getSetting("catalog_refreshed_at")).toBeUndefined();
    apple.gets.length = 0;
    clock.advance(10 * 60e3);
    await service.refreshIfStale(24 * 3600e3);
    expect(apple.gets).toEqual([]);
    clock.advance(21 * 60e3);
    await service.refreshIfStale(24 * 3600e3);
    expect(apple.gets[0]).toBe("buy-iphone");
  });

  test("a broken index page is not retried every cycle", async () => {
    const { service, apple, clock } = setup({ "buy-iphone": { kind: "ok", text: "<html></html>" } });
    await service.refreshIfStale(24 * 3600e3);
    clock.advance(60e3);
    await service.refreshIfStale(24 * 3600e3);
    expect(apple.gets).toEqual(["buy-iphone"]);
  });

  test("concurrent refreshes share one run", async () => {
    const { service, apple } = setup();
    const [a, b] = await Promise.all([service.refresh(), service.refresh()]);
    expect(apple.gets).toHaveLength(7);
    expect(b).toEqual(a);
  });

  test("a block elsewhere stops the refresh before its next request", async () => {
    const { service, apple, gate } = setup();
    const get = apple.client.get;
    apple.client.get = async (path) => {
      const response = await get(path);
      if (path.endsWith("iphoneair")) gate.reportFailure("blocked", "HTTP 541");
      return response;
    };
    await service.refresh();
    expect(apple.gets.at(-1)).toBe("product-locator-meta?family=iphoneair");
    expect(apple.gets).toHaveLength(4);
  });

  test("no requests while the gate is closed", async () => {
    const { service, gate, apple } = setup();
    gate.reportFailure("blocked", "HTTP 541");
    expect(await service.refresh()).toEqual({ ok: false, families: [] });
    expect(apple.gets).toEqual([]);
  });

  test("an index page without models changes nothing", async () => {
    const { service, repo } = setup({ "buy-iphone": { kind: "ok", text: "<html></html>" } });
    repo.upsertCatalogItems([airItem], 0);
    expect((await service.refresh()).ok).toBe(false);
    expect(repo.getCatalogItem("MG2U4QL/A")?.active).toBe(true);
    expect(repo.getSetting("catalog_refreshed_at")).toBeUndefined();
  });
});

describe("refreshIfStale", () => {
  test("refreshes an empty catalog", async () => {
    const { service, apple } = setup();
    await service.refreshIfStale(24 * 3600e3);
    expect(apple.gets.length).toBe(7);
  });

  test("skips a fresh catalog", async () => {
    const { service, apple, clock } = setup();
    await service.refresh();
    apple.gets.length = 0;
    clock.advance(3600e3);
    await service.refreshIfStale(24 * 3600e3);
    expect(apple.gets).toEqual([]);
  });
});

describe("lookupCustomPart", () => {
  test("invalid input makes no request", async () => {
    const { service, apple } = setup();
    expect(await service.lookupCustomPart("nope", "8001")).toEqual({ kind: "invalid" });
    expect(apple.pickups).toEqual([]);
  });

  test("a part Apple knows is added", async () => {
    const { service, apple, repo } = setup();
    apple.queuePickup(pickupFixture("pickup-message-single-store.json"));
    expect(await service.lookupCustomPart("mk2d4ql/a", "8001")).toEqual({
      kind: "added",
      partNumber: "MK2D4QL/A",
      title: "iPhone Duo 256 GB Sternenweiß",
    });
    expect(apple.pickups).toEqual([["MK2D4QL/A"]]);
    expect(repo.getCatalogItem("MK2D4QL/A")).toMatchObject({ isCustom: true, title: "iPhone Duo 256 GB Sternenweiß" });
  });

  test("an empty answer means Apple doesn't know the part", async () => {
    const { service, apple, gate } = setup();
    apple.queuePickup({ kind: "empty" });
    expect(await service.lookupCustomPart("ZZZZ9QL/A", "8001")).toEqual({ kind: "unknown" });
    expect(gate.isOpen()).toBe(true);
  });

  test("a block reports backoff and closes the gate", async () => {
    const { service, apple, gate } = setup();
    apple.queuePickup({ kind: "blocked", httpStatus: 541 });
    expect(await service.lookupCustomPart("MK2D4QL/A", "8001")).toEqual({ kind: "backoff" });
    expect(gate.isOpen()).toBe(false);
  });

  test("an error is passed through without touching the gate", async () => {
    const { service, apple, gate } = setup();
    apple.queuePickup({ kind: "error", message: "HTTP 500" });
    expect(await service.lookupCustomPart("MK2D4QL/A", "8001")).toEqual({ kind: "error", message: "HTTP 500" });
    expect(gate.isOpen()).toBe(true);
  });

  test("no request during backoff", async () => {
    const { service, apple, gate } = setup();
    gate.reportFailure("blocked", "HTTP 541");
    expect(await service.lookupCustomPart("MK2D4QL/A", "8001")).toEqual({ kind: "backoff" });
    expect(apple.pickups).toEqual([]);
  });
});
