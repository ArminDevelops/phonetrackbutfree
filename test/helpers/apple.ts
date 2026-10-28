import type { AppleClient, AppleResponse } from "../../src/apple/client.js";
import { parsePickupJson } from "../../src/apple/pickup.js";
import type { BatchResult } from "../../src/apple/types.js";
import { fixture } from "./fixtures.js";

export const FAMILIES = ["iphoneduo", "iphone18pro", "iphoneair", "iphone17", "iphone17e", "iphone16"];

/** Serves the recorded catalog fixtures; `overrides` replaces responses by path. */
export function fixtureApple(overrides: Record<string, AppleResponse> = {}) {
  const gets: string[] = [];
  const pickups: string[][] = [];
  let pickupQueue: BatchResult[] = [];
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
      return pickupQueue.shift() ?? { kind: "error", message: "no fake pickup response queued" };
    },
  };
  return {
    client,
    gets,
    pickups,
    queuePickup(...results: BatchResult[]) {
      pickupQueue.push(...results);
    },
  };
}

export function pickupFixture(name: string): BatchResult {
  return parsePickupJson(fixture(name));
}
