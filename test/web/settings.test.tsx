import { describe, expect, test } from "vitest";
import { buildTestMessage } from "../../src/notify/ntfy.js";
import { makeTestApp, okStatus, TOPIC } from "./helpers.js";

describe("settings page", () => {
  test("shows the topic, subscribe link and QR code", async () => {
    const t = makeTestApp();
    const res = await t.app.request("/settings");
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain(TOPIC);
    expect(html).toContain(`https://ntfy.sh/${TOPIC}`);
    expect(html).toContain("<svg");
    expect(html).toContain("/static/htmx.min.js");
  });

  test("test notification is sent and reported", async () => {
    const t = makeTestApp();
    const res = await t.post("/settings/test-notification", {});
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toMatch(/^\/settings\?flash=.*sent/i);
    expect(t.sent).toEqual([buildTestMessage(TOPIC)]);
    expect(t.repo.listNotifications(5)[0]).toMatchObject({ kind: "test", ok: true });
  });

  test("a failed test notification shows the error", async () => {
    const t = makeTestApp();
    t.setSendResult({ ok: false, error: "HTTP 429: limit" });
    const res = await t.post("/settings/test-notification", {});
    expect(decodeURIComponent(res.headers.get("location")!)).toContain("HTTP 429: limit");
  });

  test("catalog refresh is started", async () => {
    const t = makeTestApp();
    const res = await t.post("/settings/refresh-catalog", {});
    expect(res.status).toBe(303);
    expect(decodeURIComponent(res.headers.get("location")!)).toContain("Catalog refresh started");
    expect(t.refreshes).toBe(1);
  });

  test("flash message is shown", async () => {
    const t = makeTestApp();
    expect(await (await t.app.request("/settings?flash=Hello%20there")).text()).toContain("Hello there");
  });
});

describe("health pill", () => {
  test("ok shows time since last success", async () => {
    const t = makeTestApp();
    const html = await (await t.app.request("/partials/health")).text();
    expect(html).toContain("last success 12 s ago");
    expect(html).not.toContain("<html");
  });

  test("blocked shows the retry time in Swiss time", async () => {
    const t = makeTestApp();
    t.setStatus(okStatus(t.clock.now(), { state: "blocked", backoffUntil: Date.UTC(2026, 9, 28, 13, 12) }));
    const html = await (await t.app.request("/partials/health")).text();
    expect(html).toContain("Blocked by Apple");
    expect(html).toContain("14:12");
  });

  test("starting", async () => {
    const t = makeTestApp();
    t.setStatus(okStatus(t.clock.now(), { state: "starting", lastSuccessAt: null }));
    expect(await (await t.app.request("/partials/health")).text()).toContain("Starting");
  });
});

describe("static files and API", () => {
  test("htmx is served locally", async () => {
    const res = await makeTestApp().app.request("/static/htmx.min.js");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toMatch(/javascript/);
    expect((await res.text()).length).toBeGreaterThan(10_000);
  });

  test("stylesheet", async () => {
    const res = await makeTestApp().app.request("/static/styles.css");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toMatch(/css/);
  });

  test("status JSON", async () => {
    const t = makeTestApp();
    expect(await (await t.app.request("/api/status")).json()).toEqual(okStatus(t.clock.now()));
  });
});
