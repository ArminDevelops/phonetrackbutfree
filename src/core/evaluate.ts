import type { Observation, PickupStatus } from "../apple/types.js";
import type { Alert, Repo } from "../db/repo.js";

export interface StateChange {
  partNumber: string;
  storeNumber: string;
  from: PickupStatus;
  to: PickupStatus;
}

export interface AlertMatch {
  alert: Alert;
  /** Newly available (part, store) pairs to push about now. */
  observations: Observation[];
}

/** Records the last known status per (part, store) and logs restock / sold-out events. */
export function applyObservations(repo: Repo, observations: Observation[], now: number): StateChange[] {
  const changes: StateChange[] = [];
  for (const o of observations) {
    const previous = repo.getAvailability(o.partNumber, o.storeNumber);
    const changed = previous !== undefined && previous.status !== o.status;
    repo.upsertAvailability({
      partNumber: o.partNumber,
      storeNumber: o.storeNumber,
      status: o.status,
      pickupDisplay: o.pickupDisplay,
      quote: o.quote,
      productTitle: o.productTitle,
      lastCheckedAt: now,
      lastChangedAt: previous && !changed ? previous.lastChangedAt : now,
    });
    if (changed) {
      changes.push({ partNumber: o.partNumber, storeNumber: o.storeNumber, from: previous.status, to: o.status });
      repo.insertEvent({
        partNumber: o.partNumber,
        storeNumber: o.storeNumber,
        kind: o.status === "available" ? "restock" : "soldout",
        at: now,
      });
    }
  }
  return changes;
}

/**
 * Decides which (alert, part, store) pairs deserve a push. Selling out re-arms a
 * pair; coming back within `cooldownMs` of the last push is treated as a flap and
 * silently re-armed as active instead.
 */
export function evaluateAlerts(repo: Repo, observations: Observation[], now: number, cooldownMs: number): AlertMatch[] {
  const matches: AlertMatch[] = [];
  for (const alert of repo.listAlerts()) {
    if (!alert.enabled) continue;
    const parts = new Set(alert.partNumbers);
    const stores = new Set(alert.storeNumbers);
    const due: Observation[] = [];
    for (const o of observations) {
      if (!parts.has(o.partNumber) || !stores.has(o.storeNumber)) continue;
      const hit = repo.getHit(alert.id, o.partNumber, o.storeNumber);
      if (o.status === "unavailable") {
        if (hit?.active) repo.upsertHit({ ...hit, active: false });
        continue;
      }
      if (hit?.active) continue;
      if (hit?.lastNotifiedAt != null && now - hit.lastNotifiedAt < cooldownMs) {
        repo.upsertHit({ ...hit, active: true });
        continue;
      }
      due.push(o);
    }
    if (due.length > 0) matches.push({ alert, observations: due });
  }
  return matches;
}

export function markNotified(repo: Repo, match: AlertMatch, now: number): void {
  for (const o of match.observations) {
    repo.upsertHit({
      alertId: match.alert.id,
      partNumber: o.partNumber,
      storeNumber: o.storeNumber,
      active: true,
      lastNotifiedAt: now,
    });
  }
}
