import { expect, test } from "vitest";
import { loadConfig } from "../src/config.js";

test("defaults", () => {
  expect(loadConfig({})).toEqual({
    port: 4321,
    host: "127.0.0.1",
    dataDir: "./data",
    pollIntervalSeconds: 90,
    maxRequestsPerHour: 45,
    appleLocation: "8001",
    ntfyServer: "https://ntfy.sh",
    ntfyTopic: null,
    ntfyToken: null,
    renotifyCooldownMinutes: 10,
    healthAlertAfterMinutes: 15,
    pauseAlertAfterMinutes: 30,
    heartbeatUrl: null,
    allowedHosts: ["127.0.0.1", "localhost", "::1"],
    dashboardUser: null,
    dashboardPassword: null,
    clientCertToken: null,
  });
});

test("client certificate token must be long", () => {
  expect(loadConfig({ CLIENT_CERT_TOKEN: "a".repeat(32) }).clientCertToken).toBe("a".repeat(32));
  expect(() => loadConfig({ CLIENT_CERT_TOKEN: "short" })).toThrow("CLIENT_CERT_TOKEN");
});

test("extra allowed hosts extend the loopback names", () => {
  expect(loadConfig({ ALLOWED_HOSTS: " Stock.Example.com, [::1] ,localhost" }).allowedHosts).toEqual([
    "127.0.0.1",
    "localhost",
    "::1",
    "stock.example.com",
  ]);
});

test("dashboard credentials come as a pair", () => {
  expect(loadConfig({ DASHBOARD_USER: "admin", DASHBOARD_PASSWORD: "s3cret" })).toMatchObject({
    dashboardUser: "admin",
    dashboardPassword: "s3cret",
  });
  expect(() => loadConfig({ DASHBOARD_USER: "admin" })).toThrow("DASHBOARD_PASSWORD");
  expect(() => loadConfig({ DASHBOARD_PASSWORD: "s3cret" })).toThrow("DASHBOARD_USER");
});

test("overrides", () => {
  const c = loadConfig({
    POLL_INTERVAL_SECONDS: "45",
    NTFY_SERVER: "https://ntfy.example.com/",
    NTFY_TOPIC: "my_topic-1",
    HEARTBEAT_URL: "https://hc-ping.com/x",
  });
  expect(c.pollIntervalSeconds).toBe(45);
  expect(c.ntfyServer).toBe("https://ntfy.example.com");
  expect(c.ntfyTopic).toBe("my_topic-1");
  expect(c.heartbeatUrl).toBe("https://hc-ping.com/x");
});

test("empty strings are unset", () => {
  const c = loadConfig({ NTFY_TOPIC: "", NTFY_TOKEN: "" });
  expect(c.ntfyTopic).toBeNull();
  expect(c.ntfyToken).toBeNull();
});

test.each([
  ["POLL_INTERVAL_SECONDS", "abc"],
  ["POLL_INTERVAL_SECONDS", "0"],
  ["PORT", "-1"],
  ["APPLE_LOCATION", "800"],
  ["APPLE_LOCATION", "0800"],
  ["NTFY_TOPIC", "has space"],
])("rejects %s=%s", (key, value) => {
  expect(() => loadConfig({ [key]: value })).toThrow(key);
});
