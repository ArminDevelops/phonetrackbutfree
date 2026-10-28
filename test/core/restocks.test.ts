import { expect, test } from "vitest";
import { pairRestockDurations } from "../../src/core/restocks.js";
import type { EventRow } from "../../src/db/repo.js";

const T0 = Date.UTC(2026, 9, 28, 13, 0);
const MIN = 60_000;

test("pairs each restock with the next sell-out of the same pair", () => {
  const events: EventRow[] = [
    { id: 3, partNumber: "A", storeNumber: "R309", kind: "restock", at: T0 + 5 * MIN },
    { id: 2, partNumber: "A", storeNumber: "R159", kind: "soldout", at: T0 + 23 * MIN },
    { id: 1, partNumber: "A", storeNumber: "R159", kind: "restock", at: T0 },
    { id: 4, partNumber: "B", storeNumber: "R309", kind: "soldout", at: T0 + 30 * MIN },
  ];
  const durations = pairRestockDurations(events);
  expect(durations.get(1)).toBe(23 * MIN);
  expect(durations.get(3)).toBeNull();
  expect(durations.has(2)).toBe(false);
});

test("a later restock pairs with its own sell-out", () => {
  const events: EventRow[] = [
    { id: 1, partNumber: "A", storeNumber: "R159", kind: "restock", at: T0 },
    { id: 2, partNumber: "A", storeNumber: "R159", kind: "soldout", at: T0 + MIN },
    { id: 3, partNumber: "A", storeNumber: "R159", kind: "restock", at: T0 + 10 * MIN },
    { id: 4, partNumber: "A", storeNumber: "R159", kind: "soldout", at: T0 + 13 * MIN },
  ];
  const durations = pairRestockDurations(events);
  expect(durations.get(1)).toBe(MIN);
  expect(durations.get(3)).toBe(3 * MIN);
});
