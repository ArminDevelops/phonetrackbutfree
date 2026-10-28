import { describe, expect, test } from "vitest";
import { HealthMonitor } from "../../src/core/health.js";
import { openDb } from "../../src/db/db.js";
import { Repo } from "../../src/db/repo.js";

const T0 = Date.UTC(2026, 9, 28, 13, 0);
const MIN = 60_000;
const HOUR = 60 * MIN;
const blocked = { kind: "blocked" as const, message: "blocked, HTTP 541" };
const success = { kind: "success" as const };

function monitor(repo = new Repo(openDb(":memory:"))) {
  return new HealthMonitor({ repo, healthAfterMs: 15 * MIN, pauseAfterMs: 30 * MIN });
}

describe("failure streaks", () => {
  test("one degraded push after 15 minutes, one recovered push after", () => {
    const h = monitor();
    expect(h.recordCycle(blocked, T0)).toBeNull();
    expect(h.recordCycle(blocked, T0 + 5 * MIN)).toBeNull();
    expect(h.recordCycle(blocked, T0 + 14 * MIN)).toBeNull();
    expect(h.recordCycle(blocked, T0 + 15 * MIN)).toEqual({ kind: "degraded", since: T0, reason: "blocked, HTTP 541" });
    expect(h.recordCycle(blocked, T0 + 16 * MIN)).toBeNull();
    expect(h.recordCycle(success, T0 + 20 * MIN)).toEqual({ kind: "recovered", downMs: 20 * MIN });
    expect(h.recordCycle(success, T0 + 21 * MIN)).toBeNull();
  });

  test("a short failure stays quiet", () => {
    const h = monitor();
    expect(h.recordCycle({ kind: "error", message: "timeout" }, T0)).toBeNull();
    expect(h.recordCycle(success, T0 + 5 * MIN)).toBeNull();
    expect(h.snapshot().failingSince).toBeNull();
  });
});

describe("pauses", () => {
  test("a long gap since the last cycle is reported once", () => {
    const repo = new Repo(openDb(":memory:"));
    repo.setSetting("last_cycle_at", String(T0));
    const h = monitor(repo);
    expect(h.checkPause(T0 + 29 * MIN)).toBeNull();
    expect(h.checkPause(T0 + 6 * HOUR)).toEqual({ kind: "resumed", pausedMs: 6 * HOUR });
    expect(h.checkPause(T0 + 6 * HOUR + 1)).toBeNull();
  });

  test("sleep time does not count as failure time", () => {
    const h = monitor();
    h.recordCycle(blocked, T0);
    expect(h.checkPause(T0 + 6 * HOUR)).toEqual({ kind: "resumed", pausedMs: 6 * HOUR });
    expect(h.recordCycle(blocked, T0 + 6 * HOUR)).toBeNull();
    expect(h.recordCycle(blocked, T0 + 6 * HOUR + 15 * MIN)).toEqual({
      kind: "degraded",
      since: T0 + 6 * HOUR,
      reason: "blocked, HTTP 541",
    });
  });

  test("a warning sent before a pause still gets its recovery push", () => {
    const h = monitor();
    h.recordCycle(blocked, T0);
    expect(h.recordCycle(blocked, T0 + 15 * MIN)?.kind).toBe("degraded");
    h.checkPause(T0 + 6 * HOUR);
    expect(h.recordCycle(success, T0 + 6 * HOUR)).toEqual({ kind: "recovered", downMs: 6 * HOUR });
  });

  test("fresh install has no pause", () => {
    expect(monitor().checkPause(T0)).toBeNull();
  });

  test("cycle times survive a restart", () => {
    const repo = new Repo(openDb(":memory:"));
    monitor(repo).recordCycle(success, T0);
    expect(monitor(repo).snapshot()).toEqual({ failingSince: null, degradedSent: false, lastSuccessAt: T0, lastCycleAt: T0 });
  });
});
