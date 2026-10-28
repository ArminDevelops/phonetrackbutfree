import type { AvailabilityRow, CatalogRow } from "../db/repo.js";
import { formatTime } from "../time.js";

export const STALE_AFTER_MS = 10 * 60_000;

/** CSS classes for one (part, store) pair: available | unavailable | nodata, plus stale. */
export function pairClass(row: AvailabilityRow | undefined, now: number): string {
  if (!row) return "nodata";
  return now - row.lastCheckedAt > STALE_AFTER_MS ? `${row.status} stale` : row.status;
}

export function pairTitle(row: AvailabilityRow | undefined): string {
  return row ? `${row.quote || row.status} · checked ${formatTime(row.lastCheckedAt)}` : "No data yet";
}

/** "256gb" / "1tb" / "256 GB" → GB, for sorting capacities. Unknown → Infinity. */
export function capacityGb(item: Pick<CatalogRow, "capacityKey" | "capacityLabel">): number {
  const match = /(\d+)\s*(gb|tb)/i.exec(item.capacityKey || item.capacityLabel);
  if (!match) return Number.POSITIVE_INFINITY;
  return Number(match[1]) * (match[2]!.toLowerCase() === "tb" ? 1024 : 1);
}

export function availabilityIndex(rows: AvailabilityRow[]): (part: string, store: string) => AvailabilityRow | undefined {
  const map = new Map(rows.map((r) => [`${r.partNumber}|${r.storeNumber}`, r]));
  return (part, store) => map.get(`${part}|${store}`);
}
