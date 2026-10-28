import { describe, expect, test } from "vitest";
import { buildPickupPath, parsePickupJson } from "../../src/apple/pickup.js";
import type { BatchResult, Observation } from "../../src/apple/types.js";
import { fixture, fixtureJson } from "../helpers/fixtures.js";

function find(result: BatchResult, part: string, store: string): Observation | undefined {
  if (result.kind !== "success") throw new Error(`expected success, got ${result.kind}`);
  return result.observations.find((o) => o.partNumber === part && o.storeNumber === store);
}

describe("buildPickupPath", () => {
  test("encodes parts and location", () => {
    expect(buildPickupPath(["MK2D4QL/A", "MK2E4QL/A"], "8001")).toBe(
      "retail/pickup-message?pl=true&mts.0=regular&parts.0=MK2D4QL%2FA&parts.1=MK2E4QL%2FA&location=8001",
    );
  });

  test("rejects zero or more than 20 parts", () => {
    expect(() => buildPickupPath([], "8001")).toThrow();
    expect(() => buildPickupPath(Array(21).fill("A"), "8001")).toThrow();
  });
});

describe("parsePickupJson", () => {
  test("parses the 20-part response for all four stores", () => {
    const result = parsePickupJson(fixture("pickup-message-20parts.json"));
    if (result.kind !== "success") throw new Error(result.kind);
    expect(result.stores.map((s) => s.storeNumber)).toEqual(["R159", "R309", "R439", "R275"]);
    expect(result.stores[0]).toEqual({ storeNumber: "R159", name: "Rennweg", city: "Zürich" });
    expect(result.observations).toHaveLength(80);
    expect(find(result, "MK2D4QL/A", "R159")).toMatchObject({
      status: "unavailable",
      pickupDisplay: "unavailable",
      quote: "Derzeit nicht verfügbar",
      productTitle: "iPhone Duo 256 GB Sternenweiß",
    });
    expect(find(result, "MJY04QL/A", "R159")).toMatchObject({
      status: "available",
      quote: "Verfügbar Heute",
      productTitle: "iPhone 18 Pro Max 1 TB Burgunder",
    });
  });

  test("ineligible maps to unavailable", () => {
    const json = fixtureJson("pickup-message-single-store.json");
    json.body.stores[0].partsAvailability["MK2D4QL/A"].pickupDisplay = "ineligible";
    const result = parsePickupJson(JSON.stringify(json));
    expect(find(result, "MK2D4QL/A", "R275")).toMatchObject({ status: "unavailable", pickupDisplay: "ineligible" });
  });

  test("any unexpected display value is not treated as available", () => {
    const json = fixtureJson("pickup-message-single-store.json");
    json.body.stores[0].partsAvailability["MK2D4QL/A"].pickupDisplay = "something-new";
    expect(find(parsePickupJson(JSON.stringify(json)), "MK2D4QL/A", "R275")?.status).toBe("unavailable");
  });

  test("single store response", () => {
    expect(parsePickupJson(fixture("pickup-message-single-store.json"))).toMatchObject({
      kind: "success",
      stores: [{ storeNumber: "R275", name: "Rue de Rive", city: "Genève" }],
    });
  });

  test("only unknown parts gives empty", () => {
    expect(parsePickupJson(fixture("pickup-message-unknown-part-only.json"))).toEqual({ kind: "empty" });
  });

  test("bad location gives empty with Apple's message", () => {
    const text = '{"head":{"status":"200"},"body":{"errorMessage":"Bitte gib eine gültige Stadt oder Postleitzahl ein."}}';
    expect(parsePickupJson(text)).toEqual({
      kind: "empty",
      message: "Bitte gib eine gültige Stadt oder Postleitzahl ein.",
    });
  });

  test("an HTML page is an error, not a result", () => {
    expect(parsePickupJson(fixture("blocked-541.html"))).toMatchObject({ kind: "error" });
  });
});
