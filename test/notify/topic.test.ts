import { expect, test } from "vitest";
import { loadConfig } from "../../src/config.js";
import { openDb } from "../../src/db/db.js";
import { Repo } from "../../src/db/repo.js";
import { generateTopic, resolveTopic } from "../../src/notify/topic.js";

test("generated topics are long and random", () => {
  expect(generateTopic(() => new Uint8Array(24))).toBe("apple-ch-aaaaaaaaaaaaaaaaaaaaaaaa");
  expect(generateTopic()).toMatch(/^apple-ch-[a-z2-7]{24}$/);
  expect(generateTopic()).not.toBe(generateTopic());
});

test("configured topic wins and is not persisted", () => {
  const repo = new Repo(openDb(":memory:"));
  expect(resolveTopic(loadConfig({ NTFY_TOPIC: "mine" }), repo)).toBe("mine");
  expect(repo.getSetting("ntfy_topic")).toBeUndefined();
});

test("otherwise a topic is generated once and kept", () => {
  const db = openDb(":memory:");
  const first = resolveTopic(loadConfig({}), new Repo(db));
  expect(first).toMatch(/^apple-ch-/);
  expect(resolveTopic(loadConfig({}), new Repo(db))).toBe(first);
});
