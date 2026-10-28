import type { EventRow } from "../db/repo.js";

/** Restock event id → ms until the next sell-out of the same (part, store), or null if still available. */
export function pairRestockDurations(events: EventRow[]): Map<number, number | null> {
  const chronological = [...events].sort((a, b) => a.at - b.at || a.id - b.id);
  const open = new Map<string, EventRow>();
  const durations = new Map<number, number | null>();
  for (const event of chronological) {
    const key = `${event.partNumber}|${event.storeNumber}`;
    if (event.kind === "restock") {
      open.set(key, event);
      durations.set(event.id, null);
    } else {
      const restock = open.get(key);
      if (restock) durations.set(restock.id, event.at - restock.at);
      open.delete(key);
    }
  }
  return durations;
}
