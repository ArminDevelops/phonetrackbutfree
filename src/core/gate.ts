import type { Clock } from "../time.js";

export const BLOCKED_BACKOFF_S = [90, 180, 300, 600];
export const ERROR_BACKOFF_S = [30, 60, 120, 300];
export type FailureKind = "blocked" | "error";

const HOUR_MS = 3_600_000;

export function jitter(ms: number, random: () => number, fraction = 0.2): number {
  return Math.round(ms * (1 + fraction * (2 * random() - 1)));
}

/**
 * The single place that decides whether we may talk to Apple right now.
 * Every Apple request (polling, catalog, custom-part lookups) goes through it.
 */
export class AppleGate {
  private until: number | null = null;
  private failure: { kind: FailureKind; message: string; at: number } | null = null;
  private streak = 0;
  private requests: number[] = [];

  constructor(
    private readonly clock: Clock,
    private readonly random: () => number = Math.random,
  ) {}

  isOpen(): boolean {
    return this.until === null || this.clock.now() >= this.until;
  }

  get backoffUntil(): number | null {
    return this.until;
  }

  get lastFailure(): { kind: FailureKind; message: string; at: number } | null {
    return this.failure;
  }

  get consecutiveFailures(): number {
    return this.streak;
  }

  countRequest(): void {
    this.requests.push(this.clock.now());
    this.prune();
  }

  requestsLastHour(): number {
    this.prune();
    return this.requests.length;
  }

  reportSuccess(): void {
    this.until = null;
    this.streak = 0;
  }

  reportFailure(kind: FailureKind, message: string): void {
    const now = this.clock.now();
    this.streak = this.failure?.kind === kind && this.streak > 0 ? this.streak + 1 : 1;
    this.failure = { kind, message, at: now };
    const steps = kind === "blocked" ? BLOCKED_BACKOFF_S : ERROR_BACKOFF_S;
    const seconds = steps[Math.min(this.streak, steps.length) - 1]!;
    this.until = now + jitter(seconds * 1000, this.random);
  }

  private prune(): void {
    const cutoff = this.clock.now() - HOUR_MS;
    while (this.requests.length > 0 && this.requests[0]! < cutoff) this.requests.shift();
  }
}
