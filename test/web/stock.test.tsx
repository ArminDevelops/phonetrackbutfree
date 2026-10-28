import { describe, expect, test } from "vitest";
import { seedCatalog } from "../helpers/catalog.js";
import { makeTestApp } from "./helpers.js";

const MIN = 60_000;

function withDuoStock() {
  const t = makeTestApp();
  seedCatalog(t.repo, ["iphoneduo"]);
  const now = t.clock.now();
  const row = (partNumber: string, status: "available" | "unavailable", checkedAt: number) =>
    t.repo.upsertAvailability({
      partNumber,
      storeNumber: "R159",
      status,
      pickupDisplay: status,
      quote: status === "available" ? "Verfügbar Heute" : "Derzeit nicht verfügbar",
      productTitle: "",
      lastCheckedAt: checkedAt,
      lastChangedAt: checkedAt,
    });
  row("MK2D4QL/A", "available", now);
  row("MK2E4QL/A", "unavailable", now - 20 * MIN);
  return t;
}

function cellClass(html: string, part: string, store: string): string | undefined {
  return new RegExp(`<td class="cell ([^"]+)"[^>]*data-part="${part.replace("/", "\\/")}" data-store="${store}"`).exec(html)?.[1];
}

describe("live stock", () => {
  test("grid shows stores in order and cell states", async () => {
    const html = await (await withDuoStock().app.request("/stock")).text();
    const headers = [...html.matchAll(/<th class="store">([^<]+)/g)].map((m) => m[1]);
    expect(headers).toEqual(["Rennweg", "Glattzentrum", "Freie Strasse", "Rue de Rive"]);
    expect(cellClass(html, "MK2D4QL/A", "R159")).toBe("available");
    expect(cellClass(html, "MK2E4QL/A", "R159")).toBe("unavailable stale");
    expect(cellClass(html, "MK2D4QL/A", "R309")).toBe("nodata");
    expect(html.replace(/<[^>]+>/g, "")).toContain("1 of 8 configurations available somewhere");
    expect(html).toContain("iPhone Duo");
  });

  test("partial is just the grid", async () => {
    const html = await (await withDuoStock().app.request("/partials/stock")).text();
    expect(html).toContain('id="stock-grid"');
    expect(html).not.toContain("<html");
  });

  test("empty catalog", async () => {
    expect(await (await makeTestApp().app.request("/stock")).text()).toContain("Catalog is still loading");
  });
});

describe("restocks", () => {
  test("lists events newest first with durations", async () => {
    const t = makeTestApp();
    seedCatalog(t.repo, ["iphoneduo"]);
    const t0 = t.clock.now() - 60 * MIN;
    t.repo.insertEvent({ partNumber: "MK2D4QL/A", storeNumber: "R159", kind: "restock", at: t0 });
    t.repo.insertEvent({ partNumber: "MK2D4QL/A", storeNumber: "R159", kind: "soldout", at: t0 + 23 * MIN });
    t.repo.insertEvent({ partNumber: "MK2E4QL/A", storeNumber: "R309", kind: "restock", at: t0 + 30 * MIN });
    const html = await (await t.app.request("/restocks")).text();
    expect(html).toContain("Back in stock");
    expect(html).toContain("Sold out");
    expect(html).toContain("23 min");
    expect(html).toContain("still available");
    expect(html.indexOf("Nachthimmel")).toBeLessThan(html.indexOf("Sternenweiß"));
  });

  test("empty history", async () => {
    expect(await (await makeTestApp().app.request("/restocks")).text()).toContain("No restocks recorded yet");
  });
});
