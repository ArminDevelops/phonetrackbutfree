import type { AppleClient, AppleResponse } from "../../src/apple/client.js";
import { parsePickupJson } from "../../src/apple/pickup.js";
import { KNOWN_STORES } from "../../src/apple/stores.js";
import type { BatchResult } from "../../src/apple/types.js";
import { fixture } from "./fixtures.js";

export const FAMILIES = ["iphoneduo", "iphone18pro", "iphoneair", "iphone17", "iphone17e", "iphone16"];

/** Serves the recorded catalog fixtures; `overrides` replaces responses by path. */
export function fixtureApple(overrides: Record<string, AppleResponse> = {}) {
  const gets: string[] = [];
  const pickups: string[][] = [];
  let pickupQueue: BatchResult[] = [];
  let pickupHandler: ((parts: string[]) => BatchResult) | null = null;
  const client: AppleClient = {
    async get(path) {
      gets.push(path);
      if (overrides[path]) return overrides[path]!;
      if (path === "buy-iphone") return { kind: "ok", text: fixture("buy-iphone-index.html") };
      const family = /^product-locator-meta\?family=(\w+)$/.exec(path)?.[1];
      if (family && FAMILIES.includes(family)) {
        return { kind: "ok", text: fixture(`product-locator-meta-${family}.json`) };
      }
      return { kind: "ok", text: fixture("product-locator-meta-unknown-family.json") };
    },
    async pickup(parts) {
      pickups.push(parts);
      return pickupQueue.shift() ?? pickupHandler?.(parts) ?? { kind: "error", message: "no fake pickup response queued" };
    },
  };
  return {
    client,
    gets,
    pickups,
    queuePickup(...results: BatchResult[]) {
      pickupQueue.push(...results);
    },
    onPickup(handler: (parts: string[]) => BatchResult) {
      pickupHandler = handler;
    },
  };
}

export function pickupFixture(name: string): BatchResult {
  return parsePickupJson(fixture(name));
}

/** A successful answer for `parts` at all four Swiss stores; `available` lists stores per part. */
export function stock(parts: string[], available: Record<string, string[]> = {}): BatchResult {
  return {
    kind: "success",
    stores: KNOWN_STORES,
    observations: parts.flatMap((partNumber) =>
      KNOWN_STORES.map(({ storeNumber }) => {
        const isAvailable = available[partNumber]?.includes(storeNumber) ?? false;
        return {
          partNumber,
          storeNumber,
          status: isAvailable ? ("available" as const) : ("unavailable" as const),
          pickupDisplay: isAvailable ? "available" : "unavailable",
          quote: isAvailable ? "Verfügbar Heute" : "Derzeit nicht verfügbar",
          productTitle: "",
        };
      }),
    ),
  };
}
