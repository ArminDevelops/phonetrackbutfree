import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import type { CatalogItem } from "../../src/apple/types.js";
import { openDb } from "../../src/db/db.js";
import { Repo } from "../../src/db/repo.js";

const T = Date.UTC(2026, 9, 28, 13, 0);

function duoItem(partNumber: string, i: number): CatalogItem {
  return {
    partNumber,
    family: "iphoneduo",
    modelName: "iPhone Duo",
    title: `iPhone Duo ${partNumber}`,
    colorKey: i % 2 ? "nightsky" : "starwhite",
    colorLabel: i % 2 ? "Nachthimmel" : "Sternenweiß",
    capacityKey: "256gb",
    capacityLabel: "256 GB",
    screensizeKey: null,
    priceChf: 1999,
    imageKey: "img",
    productLink: `https://example.test/${partNumber}`,
    sortOrder: 0,
  };
}

const DUO = ["MK2D4QL/A", "MK2E4QL/A", "MK2F4QL/A", "MK2G4QL/A", "MK2H4QL/A", "MK2J4QL/A", "MK2K4QL/A", "MK2L4QL/A"];
const memoryRepo = () => new Repo(openDb(":memory:"));

describe("settings", () => {
  test("roundtrip", () => {
    const repo = memoryRepo();
    expect(repo.getSetting("x")).toBeUndefined();
    repo.setSetting("x", "1");
    repo.setSetting("x", "2");
    expect(repo.getSetting("x")).toBe("2");
  });
});

describe("catalog", () => {
  test("deactivates parts missing from a family and reactivates on upsert", () => {
    const repo = memoryRepo();
    repo.upsertCatalogItems(DUO.map(duoItem), T);
    expect(repo.listCatalog({ activeOnly: true })).toHaveLength(8);
    expect(repo.deactivateMissing("iphoneduo", ["MK2D4QL/A"], T + 1)).toBe(7);
    expect(repo.listCatalog({ activeOnly: true }).map((r) => r.partNumber)).toEqual(["MK2D4QL/A"]);
    expect(repo.listCatalog()).toHaveLength(8);
    repo.upsertCatalogItems(DUO.map(duoItem), T + 2);
    expect(repo.listCatalog({ activeOnly: true })).toHaveLength(8);
    expect(repo.getCatalogItem("MK2E4QL/A")).toMatchObject({ active: true, isCustom: false, priceChf: 1999, screensizeKey: null, updatedAt: T + 2 });
  });

  test("custom parts", () => {
    const repo = memoryRepo();
    repo.addCustomPart("MXP63ZM/A", "AirPods Pro", T);
    expect(repo.getCatalogItem("MXP63ZM/A")).toMatchObject({
      isCustom: true,
      active: true,
      title: "AirPods Pro",
      family: "custom",
      modelName: "Custom",
      productLink: "https://www.apple.com/ch-de/shop/product/MXP63ZM/A",
      sortOrder: 9999,
    });
  });
});

describe("stores", () => {
  test("seeded with the Swiss stores, new ones appended", () => {
    const repo = memoryRepo();
    expect(repo.listStores().map((s) => s.storeNumber)).toEqual(["R159", "R309", "R439", "R275"]);
    repo.upsertStores([{ storeNumber: "R999", name: "X", city: "Y" }, { storeNumber: "R159", name: "Rennweg", city: "Zürich" }]);
    expect(repo.listStores().map((s) => s.storeNumber)).toEqual(["R159", "R309", "R439", "R275", "R999"]);
  });
});

describe("alerts", () => {
  test("create, list, watched parts", () => {
    const repo = memoryRepo();
    const a = repo.createAlert({ name: "Duo", partNumbers: ["MK2E4QL/A", "MK2D4QL/A"], storeNumbers: ["R159", "R309"] }, T);
    const b = repo.createAlert({ name: null, partNumbers: ["MK2D4QL/A"], storeNumbers: ["R275"] }, T + 1);
    const c = repo.createAlert({ name: null, partNumbers: ["ZZZZ1QL/A"], storeNumbers: ["R275"] }, T + 2);
    repo.setAlertEnabled(c, false);
    expect(repo.getAlert(a)).toEqual({
      id: a,
      name: "Duo",
      enabled: true,
      createdAt: T,
      partNumbers: ["MK2E4QL/A", "MK2D4QL/A"],
      storeNumbers: ["R159", "R309"],
    });
    expect(repo.listAlerts().map((x) => x.id)).toEqual([c, b, a]);
    expect(repo.watchedParts()).toEqual(["MK2D4QL/A", "MK2E4QL/A"]);
  });

  test("rejects alerts without parts or stores", () => {
    const repo = memoryRepo();
    expect(() => repo.createAlert({ name: null, partNumbers: [], storeNumbers: ["R159"] }, T)).toThrow(/at least one part/);
    expect(() => repo.createAlert({ name: null, partNumbers: ["A"], storeNumbers: [] }, T)).toThrow(/at least one store/);
    expect(repo.listAlerts()).toEqual([]);
  });

  test("enabling clears hits, deleting removes everything", () => {
    const repo = memoryRepo();
    const id = repo.createAlert({ name: null, partNumbers: ["A"], storeNumbers: ["R159"] }, T);
    repo.upsertHit({ alertId: id, partNumber: "A", storeNumber: "R159", active: true, lastNotifiedAt: T });
    expect(repo.listHits(id)).toHaveLength(1);
    repo.setAlertEnabled(id, false);
    expect(repo.listHits(id)).toHaveLength(1);
    repo.setAlertEnabled(id, true);
    expect(repo.listHits(id)).toEqual([]);
    repo.upsertHit({ alertId: id, partNumber: "A", storeNumber: "R159", active: true, lastNotifiedAt: T });
    repo.deleteAlert(id);
    expect(repo.getAlert(id)).toBeUndefined();
    expect(repo.listHits(id)).toEqual([]);
  });
});

describe("availability, events, hits, notifications", () => {
  test("availability upsert and read", () => {
    const repo = memoryRepo();
    const row = {
      partNumber: "A",
      storeNumber: "R159",
      status: "available" as const,
      pickupDisplay: "available",
      quote: "Verfügbar Heute",
      productTitle: "iPhone",
      lastCheckedAt: T,
      lastChangedAt: T,
    };
    repo.upsertAvailability(row);
    repo.upsertAvailability({ ...row, status: "unavailable", lastCheckedAt: T + 1 });
    expect(repo.getAvailability("A", "R159")).toEqual({ ...row, status: "unavailable", lastCheckedAt: T + 1 });
    expect(repo.listAvailability()).toHaveLength(1);
  });

  test("events newest first", () => {
    const repo = memoryRepo();
    repo.insertEvent({ partNumber: "A", storeNumber: "R159", kind: "restock", at: T });
    repo.insertEvent({ partNumber: "A", storeNumber: "R159", kind: "soldout", at: T + 2 });
    repo.insertEvent({ partNumber: "B", storeNumber: "R159", kind: "restock", at: T + 1 });
    expect(repo.listEvents(2).map((e) => [e.partNumber, e.kind, e.at])).toEqual([
      ["A", "soldout", T + 2],
      ["B", "restock", T + 1],
    ]);
  });

  test("hit upsert", () => {
    const repo = memoryRepo();
    const id = repo.createAlert({ name: null, partNumbers: ["A"], storeNumbers: ["R159"] }, T);
    repo.upsertHit({ alertId: id, partNumber: "A", storeNumber: "R159", active: true, lastNotifiedAt: T });
    repo.upsertHit({ alertId: id, partNumber: "A", storeNumber: "R159", active: false, lastNotifiedAt: T });
    expect(repo.getHit(id, "A", "R159")).toEqual({ alertId: id, partNumber: "A", storeNumber: "R159", active: false, lastNotifiedAt: T });
    expect(repo.getHit(id, "A", "R309")).toBeUndefined();
  });

  test("notification log newest first", () => {
    const repo = memoryRepo();
    repo.logNotification({ at: T, kind: "test", alertId: null, title: "one", ok: true, error: null });
    repo.logNotification({ at: T + 1, kind: "restock", alertId: 3, title: "two", ok: false, error: "HTTP 500" });
    expect(repo.listNotifications(10)).toMatchObject([
      { at: T + 1, kind: "restock", alertId: 3, title: "two", ok: false, error: "HTTP 500" },
      { at: T, kind: "test", alertId: null, title: "one", ok: true, error: null },
    ]);
  });
});

describe("file database", () => {
  let dir: string | undefined;
  afterEach(() => dir && rmSync(dir, { recursive: true, force: true }));

  test("persists across reopen and creates the directory", () => {
    dir = mkdtempSync(join(tmpdir(), "stock-"));
    const file = join(dir, "nested", "db.sqlite");
    const db = openDb(file);
    new Repo(db).createAlert({ name: "x", partNumbers: ["A"], storeNumbers: ["R159"] }, T);
    db.close();
    const db2 = openDb(file);
    expect(new Repo(db2).listAlerts()).toHaveLength(1);
    db2.close();
  });
});
