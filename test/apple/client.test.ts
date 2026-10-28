import { describe, expect, test } from "vitest";
import { createAppleClient } from "../../src/apple/client.js";
import { APPLE_BASE, APPLE_USER_AGENT } from "../../src/apple/pickup.js";
import { fixture } from "../helpers/fixtures.js";

interface Call {
  url: string;
  headers: Record<string, string>;
}

function fakeFetch(respond: (url: string) => Response | Promise<Response>) {
  const calls: Call[] = [];
  const fetch = (async (input: string | URL, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, headers: Object.fromEntries(new Headers(init?.headers).entries()) });
    return respond(url);
  }) as typeof globalThis.fetch;
  return { fetch, calls };
}

describe("AppleClient.get", () => {
  test("requests the Swiss shop with browser-like headers", async () => {
    const { fetch, calls } = fakeFetch(() => new Response("ok"));
    const result = await createAppleClient({ fetch }).get("buy-iphone");
    expect(result).toEqual({ kind: "ok", text: "ok" });
    expect(calls[0]!.url).toBe(`${APPLE_BASE}buy-iphone`);
    expect(calls[0]!.headers["user-agent"]).toBe(APPLE_USER_AGENT);
    expect(calls[0]!.headers["accept"]).toBe("application/json");
  });

  test.each([541, 403, 429])("HTTP %i means blocked", async (status) => {
    const { fetch } = fakeFetch(() => new Response("<html></html>", { status }));
    expect(await createAppleClient({ fetch }).get("x")).toEqual({ kind: "blocked", httpStatus: status });
  });

  test.each([500, 404])("HTTP %i is an error", async (status) => {
    const { fetch } = fakeFetch(() => new Response("nope", { status }));
    expect(await createAppleClient({ fetch }).get("x")).toEqual({ kind: "error", message: `HTTP ${status}` });
  });

  test("network failure is an error", async () => {
    const { fetch } = fakeFetch(() => {
      throw new Error("getaddrinfo ENOTFOUND www.apple.com");
    });
    expect(await createAppleClient({ fetch }).get("x")).toEqual({
      kind: "error",
      message: "getaddrinfo ENOTFOUND www.apple.com",
    });
  });

  test("a hanging request times out", async () => {
    const fetch = ((_: string, init?: RequestInit) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(init.signal!.reason));
      })) as typeof globalThis.fetch;
    const result = await createAppleClient({ fetch, timeoutMs: 50 }).get("x");
    expect(result.kind).toBe("error");
    expect(result.kind === "error" && result.message).toMatch(/timeout/i);
  });
});

describe("AppleClient.pickup", () => {
  test("parses a successful response", async () => {
    const { fetch, calls } = fakeFetch(() => new Response(fixture("pickup-message-20parts.json")));
    const result = await createAppleClient({ fetch }).pickup(["MK2D4QL/A"], "8001");
    expect(result.kind).toBe("success");
    expect(calls[0]!.url).toBe(`${APPLE_BASE}retail/pickup-message?pl=true&mts.0=regular&parts.0=MK2D4QL%2FA&location=8001`);
  });

  test("541 is blocked", async () => {
    const { fetch } = fakeFetch(() => new Response(fixture("blocked-541.html"), { status: 541 }));
    expect(await createAppleClient({ fetch }).pickup(["MK2D4QL/A"], "8001")).toEqual({ kind: "blocked", httpStatus: 541 });
  });

  test("HTTP 200 with an HTML page is an error", async () => {
    const { fetch } = fakeFetch(() => new Response("<!doctype html><html><body>Wartung</body></html>"));
    expect((await createAppleClient({ fetch }).pickup(["MK2D4QL/A"], "8001")).kind).toBe("error");
  });
});
