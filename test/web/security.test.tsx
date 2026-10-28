import { describe, expect, test } from "vitest";
import { makeTestApp } from "./helpers.js";

describe("cross-site protection", () => {
  test("a POST from another website is rejected", async () => {
    const t = makeTestApp();
    const id = t.repo.createAlert({ name: null, partNumbers: ["A"], storeNumbers: ["R159"] }, t.clock.now());
    const res = await t.app.request(`/alerts/${id}/delete`, { method: "POST", headers: { origin: "https://evil.example" } });
    expect(res.status).toBe(403);
    expect(t.repo.getAlert(id)).toBeDefined();
  });

  test("a cross-site fetch without Origin is rejected too", async () => {
    const t = makeTestApp();
    const id = t.repo.createAlert({ name: null, partNumbers: ["A"], storeNumbers: ["R159"] }, t.clock.now());
    const res = await t.app.request(`/alerts/${id}/delete`, { method: "POST", headers: { "sec-fetch-site": "cross-site" } });
    expect(res.status).toBe(403);
  });

  test("the dashboard's own forms still work", async () => {
    const t = makeTestApp();
    const id = t.repo.createAlert({ name: null, partNumbers: ["A"], storeNumbers: ["R159"] }, t.clock.now());
    const res = await t.app.request(`/alerts/${id}/delete`, {
      method: "POST",
      headers: { origin: "http://localhost", "sec-fetch-site": "same-origin" },
    });
    expect(res.status).toBe(303);
    expect(t.repo.getAlert(id)).toBeUndefined();
  });

  test("a rebound host name cannot read the dashboard", async () => {
    const t = makeTestApp();
    expect((await t.app.request("http://evil.example/settings")).status).toBe(403);
    expect((await t.app.request("http://127.0.0.1:4321/settings")).status).toBe(200);
  });
});
