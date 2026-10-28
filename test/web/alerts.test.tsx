import { describe, expect, test } from "vitest";
import { seedCatalog } from "../helpers/catalog.js";
import { makeTestApp, okStatus, pageText } from "./helpers.js";

const MIN = 60_000;
const ALL = ["R159", "R309", "R439", "R275"];

function withCatalog() {
  const t = makeTestApp();
  seedCatalog(t.repo);
  return t;
}

const count = (html: string, needle: RegExp) => (html.match(needle) ?? []).length;

describe("alert list", () => {
  test("empty state", async () => {
    const html = await (await makeTestApp().app.request("/")).text();
    expect(html).toContain("No alerts yet");
    expect(html).toContain('href="/alerts/new"');
  });

  test("shows status dots and last push", async () => {
    const t = withCatalog();
    const id = t.repo.createAlert({ name: null, partNumbers: ["MK2D4QL/A"], storeNumbers: ["R159", "R309"] }, t.clock.now());
    t.repo.upsertAvailability({
      partNumber: "MK2D4QL/A",
      storeNumber: "R159",
      status: "available",
      pickupDisplay: "available",
      quote: "Verfügbar Heute",
      productTitle: "",
      lastCheckedAt: t.clock.now(),
      lastChangedAt: t.clock.now(),
    });
    t.repo.upsertHit({ alertId: id, partNumber: "MK2D4QL/A", storeNumber: "R159", active: true, lastNotifiedAt: t.clock.now() - 5 * MIN });
    const html = await (await t.app.request("/")).text();
    expect(html).toContain("iPhone Duo 256 GB Sternenweiß");
    expect(html).toContain('class="dot available"');
    expect(html).toContain('class="dot nodata"');
    expect(html).toContain("Last pushed 5 min ago");
  });

  test("never pushed", async () => {
    const t = withCatalog();
    t.repo.createAlert({ name: "Duo", partNumbers: ["MK2D4QL/A"], storeNumbers: ALL }, t.clock.now());
    expect(await (await t.app.request("/")).text()).toContain("Never pushed");
  });

  test("an alert on a part that is not in the catalog still renders", async () => {
    const t = makeTestApp();
    t.repo.createAlert({ name: null, partNumbers: ["ZZZZ1QL/A"], storeNumbers: ["R159"] }, t.clock.now());
    const res = await t.app.request("/");
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("ZZZZ1QL/A");
  });

  test("warns when Apple returns no data for a watched part", async () => {
    const t = withCatalog();
    t.repo.createAlert({ name: null, partNumbers: ["MK2D4QL/A"], storeNumbers: ALL }, t.clock.now() - 40 * MIN);
    expect(await (await t.app.request("/")).text()).toContain("Apple returns no data for this part");
  });

  test("no warning while the checker itself is failing", async () => {
    const t = withCatalog();
    t.repo.createAlert({ name: null, partNumbers: ["MK2D4QL/A"], storeNumbers: ALL }, t.clock.now() - 40 * MIN);
    t.setStatus(okStatus(t.clock.now(), { state: "blocked", lastSuccessAt: t.clock.now() - 20 * MIN }));
    expect(await (await t.app.request("/")).text()).not.toContain("Apple returns no data for this part");
  });

  test("toggle and delete", async () => {
    const t = withCatalog();
    const id = t.repo.createAlert({ name: null, partNumbers: ["MK2D4QL/A"], storeNumbers: ALL }, t.clock.now());
    expect((await t.post(`/alerts/${id}/toggle`, {})).status).toBe(303);
    expect(t.repo.getAlert(id)?.enabled).toBe(false);
    await t.post(`/alerts/${id}/toggle`, {});
    expect(t.repo.getAlert(id)?.enabled).toBe(true);
    const res = await t.post(`/alerts/${id}/delete`, {});
    expect(res.status).toBe(303);
    expect(t.repo.getAlert(id)).toBeUndefined();
  });
});

describe("new alert", () => {
  test("lists models from the catalog", async () => {
    const html = await (await withCatalog().app.request("/alerts/new")).text();
    expect(html).toContain("iPhone Duo");
    expect(html).toContain("iPhone 18 Pro Max");
    expect(html).toContain('action="/alerts/custom"');
  });

  test("model page has one checkbox per configuration and all stores ticked", async () => {
    const html = await (await withCatalog().app.request("/alerts/new?model=iPhone%20Duo")).text();
    expect(count(html, /name="part"/g)).toBe(8);
    expect(html).toContain('value="MK2D4QL/A"');
    expect(count(html, /name="store"[^>]*checked/g)).toBe(4);
  });

  test("no catalog yet", async () => {
    expect(await (await makeTestApp().app.request("/alerts/new")).text()).toContain("Catalog is still loading");
  });

  test("creates an alert", async () => {
    const t = withCatalog();
    const res = await t.post("/alerts", { part: ["MK2D4QL/A", "MK2E4QL/A"], store: ["R159", "R309"], name: " Duo " });
    expect(res.status).toBe(303);
    expect(decodeURIComponent(res.headers.get("location")!)).toBe("/?flash=Alert created");
    expect(t.repo.listAlerts()[0]).toMatchObject({ name: "Duo", partNumbers: ["MK2D4QL/A", "MK2E4QL/A"], storeNumbers: ["R159", "R309"] });
  });

  test.each([
    [{ store: ["R159"], model: "iPhone Duo" }, "Pick at least one configuration"],
    [{ part: ["MK2D4QL/A"], model: "iPhone Duo" }, "Pick at least one store"],
    [{ part: ["FAKE1QL/A"], store: ["R159"], model: "iPhone Duo" }, "Unknown configuration or store"],
    [{ part: ["MK2D4QL/A"], store: ["R000"], model: "iPhone Duo" }, "Unknown configuration or store"],
  ])("rejects %j", async (form, message) => {
    const t = withCatalog();
    const res = await t.post("/alerts", form);
    expect(res.status).toBe(400);
    expect(await res.text()).toContain(message);
    expect(t.repo.listAlerts()).toEqual([]);
  });
});

describe("custom part alerts", () => {
  test("a known part creates an alert", async () => {
    const t = makeTestApp();
    t.setLookupResult({ kind: "added", partNumber: "MXP63ZM/A", title: "AirPods Pro" });
    const res = await t.post("/alerts/custom", { partNumber: "mxp63zm/a", store: ["R159"] });
    expect(res.status).toBe(303);
    expect(decodeURIComponent(res.headers.get("location")!)).toBe("/?flash=Alert created for AirPods Pro");
    expect(t.lookups).toEqual([{ partNumber: "mxp63zm/a", location: "8001" }]);
    expect(t.repo.listAlerts()[0]).toMatchObject({ partNumbers: ["MXP63ZM/A"], storeNumbers: ["R159"] });
  });

  test.each([
    [{ kind: "invalid" as const }, 400, "That doesn't look like an Apple part number (e.g. MK2D4QL/A)"],
    [{ kind: "unknown" as const }, 400, "Apple doesn't know this part for Switzerland"],
    [{ kind: "backoff" as const }, 503, "Apple is rate-limiting us right now — try again in a few minutes"],
    [{ kind: "error" as const, message: "HTTP 500" }, 502, "HTTP 500"],
  ])("lookup result %j", async (result, status, message) => {
    const t = makeTestApp();
    t.setLookupResult(result);
    const res = await t.post("/alerts/custom", { partNumber: "MXP63ZM/A", store: ["R159"] });
    expect(res.status).toBe(status);
    expect(await pageText(res)).toContain(message);
    expect(t.repo.listAlerts()).toEqual([]);
  });

  test("needs a store before asking Apple", async () => {
    const t = makeTestApp();
    const res = await t.post("/alerts/custom", { partNumber: "MXP63ZM/A" });
    expect(res.status).toBe(400);
    expect(await res.text()).toContain("Pick at least one store");
    expect(t.lookups).toEqual([]);
  });
});
