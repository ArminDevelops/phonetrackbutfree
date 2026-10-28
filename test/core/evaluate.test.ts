import { describe, expect, test } from "vitest";
import type { Observation, PickupStatus } from "../../src/apple/types.js";
import { applyObservations, evaluateAlerts, markNotified } from "../../src/core/evaluate.js";
import { openDb } from "../../src/db/db.js";
import { Repo } from "../../src/db/repo.js";

const T0 = Date.UTC(2026, 9, 28, 13, 0);
const MIN = 60_000;
const COOLDOWN = 10 * MIN;

function obs(partNumber: string, storeNumber: string, status: PickupStatus): Observation {
  return {
    partNumber,
    storeNumber,
    status,
    pickupDisplay: status,
    quote: status === "available" ? "Verfügbar Heute" : "Derzeit nicht verfügbar",
    productTitle: `Title ${partNumber}`,
  };
}

const memoryRepo = () => new Repo(openDb(":memory:"));

describe("applyObservations", () => {
  test("first sighting records state without a change", () => {
    const repo = memoryRepo();
    expect(applyObservations(repo, [obs("A", "R159", "available")], T0)).toEqual([]);
    expect(repo.getAvailability("A", "R159")).toMatchObject({ status: "available", lastCheckedAt: T0, lastChangedAt: T0 });
    expect(repo.listEvents(10)).toEqual([]);
  });

  test("changes produce restock and soldout events", () => {
    const repo = memoryRepo();
    applyObservations(repo, [obs("A", "R159", "unavailable")], T0);
    expect(applyObservations(repo, [obs("A", "R159", "available")], T0 + MIN)).toEqual([
      { partNumber: "A", storeNumber: "R159", from: "unavailable", to: "available" },
    ]);
    applyObservations(repo, [obs("A", "R159", "unavailable")], T0 + 2 * MIN);
    expect(repo.listEvents(10).map((e) => [e.kind, e.at])).toEqual([
      ["soldout", T0 + 2 * MIN],
      ["restock", T0 + MIN],
    ]);
  });

  test("unchanged status only refreshes lastCheckedAt", () => {
    const repo = memoryRepo();
    applyObservations(repo, [obs("A", "R159", "available")], T0);
    expect(applyObservations(repo, [obs("A", "R159", "available")], T0 + MIN)).toEqual([]);
    expect(repo.getAvailability("A", "R159")).toMatchObject({ lastCheckedAt: T0 + MIN, lastChangedAt: T0 });
    expect(repo.listEvents(10)).toEqual([]);
  });
});

describe("evaluateAlerts", () => {
  function withAlert(parts = ["A"], stores = ["R159", "R309"]) {
    const repo = memoryRepo();
    const id = repo.createAlert({ name: null, partNumbers: parts, storeNumbers: stores }, T0);
    return { repo, id };
  }

  test("available pair matches once", () => {
    const { repo, id } = withAlert();
    const matches = evaluateAlerts(repo, [obs("A", "R159", "available")], T0, COOLDOWN);
    expect(matches).toHaveLength(1);
    expect(matches[0]!.alert.id).toBe(id);
    expect(matches[0]!.observations).toEqual([obs("A", "R159", "available")]);
    markNotified(repo, matches[0]!, T0);
    expect(repo.getHit(id, "A", "R159")).toEqual({ alertId: id, partNumber: "A", storeNumber: "R159", active: true, lastNotifiedAt: T0 });
    expect(evaluateAlerts(repo, [obs("A", "R159", "available")], T0 + MIN, COOLDOWN)).toEqual([]);
  });

  test("ignores other stores, other parts and disabled alerts", () => {
    const { repo, id } = withAlert();
    expect(evaluateAlerts(repo, [obs("A", "R275", "available"), obs("B", "R159", "available")], T0, COOLDOWN)).toEqual([]);
    repo.setAlertEnabled(id, false);
    expect(evaluateAlerts(repo, [obs("A", "R159", "available")], T0, COOLDOWN)).toEqual([]);
  });

  test("selling out re-arms the alert", () => {
    const { repo } = withAlert();
    markNotified(repo, evaluateAlerts(repo, [obs("A", "R159", "available")], T0, COOLDOWN)[0]!, T0);
    expect(evaluateAlerts(repo, [obs("A", "R159", "unavailable")], T0 + MIN, COOLDOWN)).toEqual([]);
    expect(evaluateAlerts(repo, [obs("A", "R159", "available")], T0 + 20 * MIN, COOLDOWN)).toHaveLength(1);
  });

  test("flapping within the cooldown is suppressed", () => {
    const { repo, id } = withAlert();
    markNotified(repo, evaluateAlerts(repo, [obs("A", "R159", "available")], T0, COOLDOWN)[0]!, T0);
    evaluateAlerts(repo, [obs("A", "R159", "unavailable")], T0 + MIN, COOLDOWN);
    expect(evaluateAlerts(repo, [obs("A", "R159", "available")], T0 + 3 * MIN, COOLDOWN)).toEqual([]);
    expect(repo.getHit(id, "A", "R159")).toMatchObject({ active: true, lastNotifiedAt: T0 });
    evaluateAlerts(repo, [obs("A", "R159", "unavailable")], T0 + 20 * MIN, COOLDOWN);
    expect(evaluateAlerts(repo, [obs("A", "R159", "available")], T0 + 21 * MIN, COOLDOWN)).toHaveLength(1);
  });

  test("several pairs of one alert become one match", () => {
    const { repo } = withAlert(["A", "B"]);
    const matches = evaluateAlerts(repo, [obs("A", "R159", "available"), obs("B", "R309", "available")], T0, COOLDOWN);
    expect(matches).toHaveLength(1);
    expect(matches[0]!.observations).toHaveLength(2);
  });

  test("two alerts on the same pair both match", () => {
    const { repo } = withAlert();
    repo.createAlert({ name: "second", partNumbers: ["A"], storeNumbers: ["R159"] }, T0);
    expect(evaluateAlerts(repo, [obs("A", "R159", "available")], T0, COOLDOWN)).toHaveLength(2);
  });

  test("no observation leaves the hit alone", () => {
    const { repo, id } = withAlert();
    markNotified(repo, evaluateAlerts(repo, [obs("A", "R159", "available")], T0, COOLDOWN)[0]!, T0);
    expect(evaluateAlerts(repo, [obs("A", "R309", "unavailable")], T0 + MIN, COOLDOWN)).toEqual([]);
    expect(repo.getHit(id, "A", "R159")?.active).toBe(true);
  });
});
