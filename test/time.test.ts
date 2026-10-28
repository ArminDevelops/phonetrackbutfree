import { expect, test } from "vitest";
import { ago, formatDateTime, formatDuration, formatTime } from "../src/time.js";

test("formatTime is Zurich time", () => {
  expect(formatTime(Date.UTC(2026, 9, 28, 13, 5))).toBe("14:05");
});

test("formatDateTime", () => {
  expect(formatDateTime(Date.UTC(2026, 9, 28, 13, 5))).toBe("28.10. 14:05");
});

test.each([
  [6 * 3600e3 + 12 * 60e3, "6 h 12 min"],
  [2 * 3600e3, "2 h"],
  [23 * 60e3, "23 min"],
  [45e3, "45 s"],
])("formatDuration(%i)", (ms, text) => {
  expect(formatDuration(ms)).toBe(text);
});

test("ago", () => {
  expect(ago(0, 12e3)).toBe("12 s ago");
  expect(ago(0, 5 * 60e3)).toBe("5 min ago");
  expect(ago(0, 3 * 3600e3)).toBe("3 h ago");
});
