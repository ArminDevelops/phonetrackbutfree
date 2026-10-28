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

describe("host allowlist", () => {
  test("an extra allowed host (a subdomain behind nginx) is accepted", async () => {
    const t = makeTestApp({ ALLOWED_HOSTS: "stock.example.com" });
    expect((await t.app.request("https://stock.example.com/settings")).status).toBe(200);
    expect((await t.app.request("https://other.example.com/settings")).status).toBe(403);
  });

  test("a form POST from the allowed subdomain works", async () => {
    const t = makeTestApp({ ALLOWED_HOSTS: "stock.example.com" });
    const id = t.repo.createAlert({ name: null, partNumbers: ["A"], storeNumbers: ["R159"] }, t.clock.now());
    const res = await t.app.request(`https://stock.example.com/alerts/${id}/delete`, {
      method: "POST",
      headers: { origin: "https://stock.example.com" },
    });
    expect(res.status).toBe(303);
  });
});

describe("basic auth", () => {
  const auth = (user: string, password: string) => ({ authorization: `Basic ${btoa(`${user}:${password}`)}` });

  test("is off unless configured", async () => {
    expect((await makeTestApp().app.request("/")).status).toBe(200);
  });

  test("protects every page when configured", async () => {
    const t = makeTestApp({ DASHBOARD_USER: "admin", DASHBOARD_PASSWORD: "s3cret" });
    const denied = await t.app.request("/settings");
    expect(denied.status).toBe(401);
    expect(denied.headers.get("www-authenticate")).toMatch(/^Basic/);
    expect((await t.app.request("/api/status")).status).toBe(401);
    expect((await t.app.request("/settings", { headers: auth("admin", "wrong") })).status).toBe(401);
    expect((await t.app.request("/settings", { headers: auth("admin", "s3cret") })).status).toBe(200);
  });

  test("the health check stays open and reveals nothing", async () => {
    const t = makeTestApp({ DASHBOARD_USER: "admin", DASHBOARD_PASSWORD: "s3cret" });
    const res = await t.app.request("/healthz");
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("ok");
  });
});

describe("client certificate token from nginx", () => {
  const TOKEN = "t".repeat(40);
  const env = { DASHBOARD_USER: "admin", DASHBOARD_PASSWORD: "s3cret", CLIENT_CERT_TOKEN: TOKEN };

  test("a request nginx vouched for skips the password", async () => {
    const t = makeTestApp(env);
    expect((await t.app.request("/settings", { headers: { "x-client-cert-token": TOKEN } })).status).toBe(200);
  });

  test("a wrong or missing token still needs the password", async () => {
    const t = makeTestApp(env);
    expect((await t.app.request("/settings", { headers: { "x-client-cert-token": "t".repeat(39) + "x" } })).status).toBe(401);
    expect((await t.app.request("/settings")).status).toBe(401);
  });

  test("the header means nothing unless a token is configured", async () => {
    const t = makeTestApp({ DASHBOARD_USER: "admin", DASHBOARD_PASSWORD: "s3cret" });
    expect((await t.app.request("/settings", { headers: { "x-client-cert-token": "" } })).status).toBe(401);
    expect((await t.app.request("/settings", { headers: { "x-client-cert-token": TOKEN } })).status).toBe(401);
  });

  test("cross-site and host checks still apply to certificate requests", async () => {
    const t = makeTestApp(env);
    const headers = { "x-client-cert-token": TOKEN, origin: "https://evil.example" };
    expect((await t.app.request("/alerts/1/delete", { method: "POST", headers })).status).toBe(403);
    expect((await t.app.request("http://evil.example/settings", { headers: { "x-client-cert-token": TOKEN } })).status).toBe(403);
  });
});
