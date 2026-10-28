import { describe, expect, test } from "vitest";
import { imageUrl } from "../../src/apple/catalog.js";
import type { Observation } from "../../src/apple/types.js";
import type { AlertMatch } from "../../src/core/evaluate.js";
import { openDb } from "../../src/db/db.js";
import { Repo, type Alert } from "../../src/db/repo.js";
import {
  buildHealthMessage,
  buildRestockMessage,
  buildTestMessage,
  createNtfyNotifier,
  type Lookup,
} from "../../src/notify/ntfy.js";
import { seedCatalog } from "../helpers/catalog.js";

const TOPIC = "apple-ch-test";

function setup() {
  const repo = new Repo(openDb(":memory:"));
  seedCatalog(repo, ["iphoneduo"]);
  const lookup: Lookup = {
    item: (p) => repo.getCatalogItem(p),
    store: (n) => repo.listStores().find((s) => s.storeNumber === n),
  };
  return { repo, lookup };
}

function available(partNumber: string, storeNumber: string, productTitle = ""): Observation {
  return { partNumber, storeNumber, status: "available", pickupDisplay: "available", quote: "Verfügbar Heute", productTitle };
}

function alert(partNumbers: string[], name: string | null = null): Alert {
  return { id: 1, name, enabled: true, createdAt: 0, partNumbers, storeNumbers: ["R159", "R309", "R439", "R275"] };
}

describe("buildRestockMessage", () => {
  test("one part at two stores", () => {
    const { repo, lookup } = setup();
    const match: AlertMatch = { alert: alert(["MK2D4QL/A"]), observations: [available("MK2D4QL/A", "R159"), available("MK2D4QL/A", "R309")] };
    const link = repo.getCatalogItem("MK2D4QL/A")!.productLink;
    expect(buildRestockMessage(TOPIC, match, lookup)).toEqual({
      topic: TOPIC,
      title: "iPhone Duo 256 GB Sternenweiß available",
      message: "Rennweg (Zürich), Glattzentrum (Wallisellen) — Verfügbar Heute",
      priority: 5,
      tags: ["iphone"],
      click: link,
      actions: [{ action: "view", label: "Buy now", url: link }],
      attach: imageUrl("iphone-duo-finish-select-star-white-202609"),
      filename: "iphone-duo-finish-select-star-white-202609.png",
    });
  });

  test("several parts in one push", () => {
    const { repo, lookup } = setup();
    const match: AlertMatch = {
      alert: alert(["MK2D4QL/A", "MK2E4QL/A"], "Duo"),
      observations: [available("MK2D4QL/A", "R159"), available("MK2E4QL/A", "R159"), available("MK2E4QL/A", "R275")],
    };
    const msg = buildRestockMessage(TOPIC, match, lookup);
    expect(msg.title).toBe("2 configs available · Duo");
    expect(msg.message).toBe(
      "iPhone Duo 256 GB Sternenweiß: Rennweg (Zürich) — Verfügbar Heute\n" +
        "iPhone Duo 256 GB Nachthimmel: Rennweg (Zürich), Rue de Rive (Genève) — Verfügbar Heute",
    );
    expect(msg.actions).toEqual([
      { action: "view", label: "Buy 256 GB Sternenweiß", url: repo.getCatalogItem("MK2D4QL/A")!.productLink },
      { action: "view", label: "Buy 256 GB Nachthimmel", url: repo.getCatalogItem("MK2E4QL/A")!.productLink },
    ]);
    expect(msg.attach).toBeUndefined();
    expect(msg.click).toBe(repo.getCatalogItem("MK2D4QL/A")!.productLink);
  });

  test("falls back when the part is not in the catalog", () => {
    const lookup: Lookup = { item: () => undefined, store: () => undefined };
    const match: AlertMatch = { alert: alert(["MK2D4QL/A"]), observations: [available("MK2D4QL/A", "R999", "iPhone Duo 256 GB Sternenweiß")] };
    const msg = buildRestockMessage(TOPIC, match, lookup);
    expect(msg.title).toBe("iPhone Duo 256 GB Sternenweiß available");
    expect(msg.message).toBe("R999 — Verfügbar Heute");
    expect(msg.click).toBe("https://www.apple.com/ch-de/shop/product/MK2D4QL/A");
    expect(msg.attach).toBeUndefined();
  });

  test("falls back to the part number when there is no title at all", () => {
    const lookup: Lookup = { item: () => undefined, store: () => undefined };
    const msg = buildRestockMessage(TOPIC, { alert: alert(["X1234QL/A"]), observations: [available("X1234QL/A", "R159")] }, lookup);
    expect(msg.title).toBe("X1234QL/A available");
  });
});

describe("health and test messages", () => {
  test("degraded", () => {
    expect(buildHealthMessage(TOPIC, { kind: "degraded", since: Date.UTC(2026, 9, 28, 13, 5), reason: "blocked, HTTP 541" })).toEqual({
      topic: TOPIC,
      title: "Stock checker can't reach Apple",
      message: "Failing since 14:05 (blocked, HTTP 541). Backing off and retrying.",
      priority: 3,
      tags: ["warning"],
    });
  });

  test("recovered", () => {
    expect(buildHealthMessage(TOPIC, { kind: "recovered", downMs: 23 * 60e3 })).toEqual({
      topic: TOPIC,
      title: "Stock checker recovered",
      message: "Checking again after 23 min of failures.",
      priority: 2,
      tags: ["white_check_mark"],
    });
  });

  test("resumed", () => {
    expect(buildHealthMessage(TOPIC, { kind: "resumed", pausedMs: (6 * 60 + 12) * 60e3 })).toEqual({
      topic: TOPIC,
      title: "Stock checker resumed",
      message: "Checking resumed after a 6 h 12 min pause (Mac was asleep or the checker wasn't running).",
      priority: 2,
      tags: ["zzz"],
    });
  });

  test("test message", () => {
    expect(buildTestMessage(TOPIC)).toEqual({
      topic: TOPIC,
      title: "Test notification",
      message: "ntfy is set up — restock alerts will arrive here.",
      priority: 3,
      tags: ["iphone"],
    });
  });
});

describe("createNtfyNotifier", () => {
  function fakeFetch(response: () => Response) {
    const calls: { url: string; init: RequestInit }[] = [];
    const fetch = (async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      return response();
    }) as unknown as typeof globalThis.fetch;
    return { fetch, calls };
  }

  test("publishes JSON to the server root", async () => {
    const { fetch, calls } = fakeFetch(() => new Response("{}"));
    const msg = buildTestMessage(TOPIC);
    expect(await createNtfyNotifier({ server: "https://ntfy.sh", token: null, fetch }).send(msg)).toEqual({ ok: true });
    expect(calls[0]!.url).toBe("https://ntfy.sh/");
    expect(calls[0]!.init.method).toBe("POST");
    expect(JSON.parse(String(calls[0]!.init.body))).toEqual(msg);
    const headers = new Headers(calls[0]!.init.headers);
    expect(headers.get("content-type")).toBe("application/json");
    expect(headers.has("authorization")).toBe(false);
  });

  test("sends a bearer token when configured", async () => {
    const { fetch, calls } = fakeFetch(() => new Response("{}"));
    await createNtfyNotifier({ server: "https://ntfy.sh", token: "tk_abc", fetch }).send(buildTestMessage(TOPIC));
    expect(new Headers(calls[0]!.init.headers).get("authorization")).toBe("Bearer tk_abc");
  });

  test("non-2xx is a failure", async () => {
    const { fetch } = fakeFetch(() => new Response("limit", { status: 429 }));
    expect(await createNtfyNotifier({ server: "https://ntfy.sh", token: null, fetch }).send(buildTestMessage(TOPIC))).toEqual({
      ok: false,
      error: "HTTP 429: limit",
    });
  });

  test("network failure is a failure", async () => {
    const fetch = (async () => {
      throw new Error("offline");
    }) as unknown as typeof globalThis.fetch;
    expect(await createNtfyNotifier({ server: "https://ntfy.sh", token: null, fetch }).send(buildTestMessage(TOPIC))).toEqual({
      ok: false,
      error: "offline",
    });
  });
});
