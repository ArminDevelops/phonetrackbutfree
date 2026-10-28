import { expect, test } from "vitest";
import { planBatches } from "../../src/core/batching.js";

const FILL = Array.from({ length: 73 }, (_, i) => `p${i}`);
const range = (from: number, to: number) => Array.from({ length: to - from + 1 }, (_, i) => `p${from + i}`);

test("nothing watched: one batch of 20 catalog parts", () => {
  expect(planBatches([], FILL, 0)).toEqual({ batches: [range(0, 19)], nextCursor: 20 });
});

test("rotation wraps around the catalog", () => {
  expect(planBatches([], FILL, 60)).toEqual({ batches: [[...range(60, 72), ...range(0, 6)]], nextCursor: 7 });
});

test("watched parts come first and fill does not duplicate them", () => {
  const { batches } = planBatches(["w1", "w2", "p5"], FILL, 0);
  expect(batches).toHaveLength(1);
  expect(batches[0]!.slice(0, 3)).toEqual(["w1", "w2", "p5"]);
  expect(batches[0]).toHaveLength(20);
  expect(new Set(batches[0]).size).toBe(20);
});

test("many watched parts span several batches, spare slots get filled", () => {
  const watched = Array.from({ length: 45 }, (_, i) => `w${i}`);
  const { batches } = planBatches(watched, range(0, 9), 0);
  expect(batches.map((b) => b.length)).toEqual([20, 20, 15]);
});

test("exactly 20 watched parts leaves no room and keeps the cursor", () => {
  const watched = Array.from({ length: 20 }, (_, i) => `w${i}`);
  expect(planBatches(watched, FILL, 13)).toEqual({ batches: [watched], nextCursor: 13 });
});

test("nothing at all", () => {
  expect(planBatches([], [], 5)).toEqual({ batches: [], nextCursor: 0 });
});

test("duplicate watched parts are collapsed", () => {
  expect(planBatches(["w1", "w1"], [], 0)).toEqual({ batches: [["w1"]], nextCursor: 0 });
});
