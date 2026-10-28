import type { Repo } from "../db/repo.js";
import type { HealthEvent } from "../notify/ntfy.js";

export type CycleOutcome = { kind: "success" } | { kind: "blocked"; message: string } | { kind: "error"; message: string };

const LAST_CYCLE_AT = "last_cycle_at";
const LAST_SUCCESS_AT = "last_success_at";

function readTime(repo: Repo, key: string): number | null {
  const value = repo.getSetting(key);
  return value === undefined ? null : Number(value);
}

/**
 * Turns cycle outcomes into the three health pushes: "can't reach Apple" after a
 * long failure streak, "recovered" when it ends, and "resumed" after a pause
 * (Mac asleep, checker stopped). Pause time never counts as failure time.
 */
export class HealthMonitor {
  private failingSince: number | null = null;
  /** Start of the outage a "degraded" push was sent for; survives pauses so recovery is always reported. */
  private degradedStreakStart: number | null = null;
  private degradedSent = false;
  private lastCycleAt: number | null;
  private lastSuccessAt: number | null;

  constructor(private readonly deps: { repo: Repo; healthAfterMs: number; pauseAfterMs: number }) {
    this.lastCycleAt = readTime(deps.repo, LAST_CYCLE_AT);
    this.lastSuccessAt = readTime(deps.repo, LAST_SUCCESS_AT);
  }

  checkPause(now: number): HealthEvent | null {
    if (this.lastCycleAt === null || now - this.lastCycleAt < this.deps.pauseAfterMs) return null;
    const pausedMs = now - this.lastCycleAt;
    this.failingSince = null;
    this.setLastCycle(now);
    return { kind: "resumed", pausedMs };
  }

  recordCycle(outcome: CycleOutcome, now: number): HealthEvent | null {
    this.setLastCycle(now);
    if (outcome.kind === "success") {
      this.lastSuccessAt = now;
      this.deps.repo.setSetting(LAST_SUCCESS_AT, String(now));
      const event: HealthEvent | null =
        this.degradedSent && this.degradedStreakStart !== null
          ? { kind: "recovered", downMs: now - this.degradedStreakStart }
          : null;
      this.failingSince = null;
      this.degradedStreakStart = null;
      this.degradedSent = false;
      return event;
    }
    this.failingSince ??= now;
    if (!this.degradedSent && now - this.failingSince >= this.deps.healthAfterMs) {
      this.degradedSent = true;
      this.degradedStreakStart = this.failingSince;
      return { kind: "degraded", since: this.failingSince, reason: outcome.message };
    }
    return null;
  }

  snapshot(): { failingSince: number | null; degradedSent: boolean; lastSuccessAt: number | null; lastCycleAt: number | null } {
    return {
      failingSince: this.failingSince,
      degradedSent: this.degradedSent,
      lastSuccessAt: this.lastSuccessAt,
      lastCycleAt: this.lastCycleAt,
    };
  }

  private setLastCycle(now: number): void {
    this.lastCycleAt = now;
    this.deps.repo.setSetting(LAST_CYCLE_AT, String(now));
  }
}
