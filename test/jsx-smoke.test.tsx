import { expect, test } from "vitest";

test("hono jsx renders", () => {
  expect((<p>hi</p>).toString()).toBe("<p>hi</p>");
});
