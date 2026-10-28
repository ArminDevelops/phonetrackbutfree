import { describe, expect, test } from "vitest";
import { AppleGate, jitter } from "../../src/core/gate.js";
import { FakeClock } from "../helpers/clock.js";

test("jitter spreads ±20 %", () => {
  expect(jitter(1000, () => 0)).toBe(800);
  expect(jitter(1000, () => 1)).toBe(1200);
  expect(jitter(1000, () => 0.5)).toBe(1000);
});

describe("AppleGate", () => {
  const delays = (gate: AppleGate, clock: FakeClock, kinds: ("blocked" | "error")[]) =>
    kinds.map((kind) => {
      gate.reportFailure(kind, "x");
      return gate.backoffUntil! - clock.now();
    });

  test("blocked backoff steps", () => {
    const clock = new FakeClock();
    const gate = new AppleGate(clock, () => 0.5);
    expect(delays(gate, clock, ["blocked", "blocked", "blocked", "blocked", "blocked", "blocked"])).toEqual([
      90e3, 180e3, 300e3, 600e3, 900e3, 900e3,
    ]);
  });

  test("error backoff steps", () => {
    const clock = new FakeClock();
    const gate = new AppleGate(clock, () => 0.5);
    expect(delays(gate, clock, ["error", "error", "error", "error", "error"])).toEqual([30e3, 60e3, 120e3, 300e3, 300e3]);
  });

  test("changing failure kind restarts the steps", () => {
    const clock = new FakeClock();
    const gate = new AppleGate(clock, () => 0.5);
    expect(delays(gate, clock, ["blocked", "blocked", "error"])).toEqual([90e3, 180e3, 30e3]);
  });

  test("closed until the backoff passes; success reopens", () => {
    const clock = new FakeClock();
    const gate = new AppleGate(clock, () => 0.5);
    expect(gate.isOpen()).toBe(true);
    gate.reportFailure("blocked", "HTTP 541");
    expect(gate.isOpen()).toBe(false);
    expect(gate.consecutiveFailures).toBe(1);
    expect(gate.lastFailure).toEqual({ kind: "blocked", message: "HTTP 541", at: clock.now() });
    clock.advance(89e3);
    expect(gate.isOpen()).toBe(false);
    clock.advance(1e3);
    expect(gate.isOpen()).toBe(true);
    gate.reportSuccess();
    expect(gate.backoffUntil).toBeNull();
    expect(gate.consecutiveFailures).toBe(0);
    expect(gate.lastFailure?.message).toBe("HTTP 541");
  });

  test("backoff survives a restart", () => {
    const clock = new FakeClock();
    let saved: string | undefined;
    const store = { load: () => saved, save: (state: string) => void (saved = state) };
    const gate = new AppleGate(clock, () => 0.5, store);
    gate.reportFailure("blocked", "HTTP 541");
    gate.reportFailure("blocked", "HTTP 541");
    const restarted = new AppleGate(clock, () => 0.5, store);
    expect(restarted.isOpen()).toBe(false);
    expect(restarted.backoffUntil).toBe(clock.now() + 180e3);
    expect(restarted.consecutiveFailures).toBe(2);
    expect(restarted.lastFailure).toEqual({ kind: "blocked", message: "HTTP 541", at: clock.now() });
    restarted.reportFailure("blocked", "HTTP 541");
    expect(restarted.backoffUntil! - clock.now()).toBe(300e3);
    restarted.reportSuccess();
    const again = new AppleGate(clock, () => 0.5, store);
    expect(again.isOpen()).toBe(true);
    expect(again.consecutiveFailures).toBe(0);
  });

  test("a corrupt saved state is ignored", () => {
    const gate = new AppleGate(new FakeClock(), () => 0.5, { load: () => "{not json", save: () => {} });
    expect(gate.isOpen()).toBe(true);
  });

  test("counts requests in the last hour", () => {
    const clock = new FakeClock();
    const gate = new AppleGate(clock);
    gate.countRequest();
    clock.advance(30 * 60e3);
    gate.countRequest();
    gate.countRequest();
    expect(gate.requestsLastHour()).toBe(3);
    clock.advance(30 * 60e3 + 1);
    expect(gate.requestsLastHour()).toBe(2);
  });
});
