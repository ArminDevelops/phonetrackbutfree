import type { Clock } from "../../src/time.js";

export class FakeClock implements Clock {
  constructor(public t = Date.UTC(2026, 9, 28, 13, 0)) {}
  now(): number {
    return this.t;
  }
  advance(ms: number): void {
    this.t += ms;
  }
}
