/**
 * Live check against apple.com: fetches the iPhone Duo catalog and its pickup
 * availability once and prints a table. `--push` also sends a test notification
 * to the configured ntfy topic. Run with `npm run smoke [-- --push]`.
 */
import { existsSync } from "node:fs";
import { join } from "node:path";
import { parseLocatorMeta } from "../src/apple/catalog.js";
import { createAppleClient } from "../src/apple/client.js";
import { loadConfig } from "../src/config.js";
import { openDb } from "../src/db/db.js";
import { Repo } from "../src/db/repo.js";
import { buildTestMessage, createNtfyNotifier } from "../src/notify/ntfy.js";
import { resolveTopic } from "../src/notify/topic.js";

if (existsSync(".env")) process.loadEnvFile(".env");
const config = loadConfig(process.env);
const apple = createAppleClient();

const meta = await apple.get("product-locator-meta?family=iphoneduo");
if (meta.kind !== "ok") {
  console.error("catalog request failed:", meta);
  process.exit(1);
}
const items = parseLocatorMeta(JSON.parse(meta.text), "iphoneduo", 0);
if (!items?.length) {
  console.error("catalog had no products");
  process.exit(1);
}
console.log(`catalog: ${items.length} iPhone Duo configurations`);

await new Promise((resolve) => setTimeout(resolve, 2500));
const started = Date.now();
const result = await apple.pickup(items.map((i) => i.partNumber), config.appleLocation);
const ms = Date.now() - started;
if (result.kind !== "success") {
  console.error(`pickup request: ${result.kind}`, result);
  process.exit(1);
}

const stores = result.stores;
console.log(`pickup: ${stores.length} stores, ${result.observations.length} observations in ${ms} ms\n`);
const pad = (s: string, n: number) => s.slice(0, n).padEnd(n);
console.log(pad("configuration", 34) + stores.map((s) => pad(s.name, 15)).join(""));
for (const item of items) {
  const cells = stores.map((s) => {
    const o = result.observations.find((x) => x.partNumber === item.partNumber && x.storeNumber === s.storeNumber);
    return pad(o ? (o.status === "available" ? "AVAILABLE" : o.pickupDisplay) : "-", 15);
  });
  console.log(pad(item.title, 34) + cells.join(""));
}

if (process.argv.includes("--push")) {
  const repo = new Repo(openDb(join(config.dataDir, "stockchecker.db")));
  const topic = resolveTopic(config, repo);
  const sent = await createNtfyNotifier({ server: config.ntfyServer, token: config.ntfyToken }).send(buildTestMessage(topic));
  console.log(`\nntfy test push to ${config.ntfyServer}/${topic}:`, sent);
  if (!sent.ok) process.exit(1);
}

if (stores.length !== 4) {
  console.error(`expected 4 Swiss stores, got ${stores.length}`);
  process.exit(1);
}
