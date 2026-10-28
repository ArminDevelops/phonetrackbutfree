import { existsSync } from "node:fs";
import { join } from "node:path";
import { serve } from "@hono/node-server";
import { createAppleClient } from "./apple/client.js";
import { loadConfig } from "./config.js";
import { CatalogService } from "./core/catalog-service.js";
import { Checker } from "./core/checker.js";
import { AppleGate } from "./core/gate.js";
import { HealthMonitor } from "./core/health.js";
import { openDb } from "./db/db.js";
import { Repo } from "./db/repo.js";
import { log } from "./log.js";
import { createNtfyNotifier } from "./notify/ntfy.js";
import { resolveTopic } from "./notify/topic.js";
import { systemClock } from "./time.js";
import { createApp } from "./web/app.js";

if (existsSync(".env")) process.loadEnvFile(".env");
const config = loadConfig(process.env);

const db = openDb(join(config.dataDir, "stockchecker.db"));
const repo = new Repo(db);
const clock = systemClock;
const gate = new AppleGate(clock);
const apple = createAppleClient();
const catalog = new CatalogService({ apple, repo, gate, clock });
const health = new HealthMonitor({
  repo,
  healthAfterMs: config.healthAlertAfterMinutes * 60_000,
  pauseAfterMs: config.pauseAlertAfterMinutes * 60_000,
});
const notifier = createNtfyNotifier({ server: config.ntfyServer, token: config.ntfyToken });
const topic = resolveTopic(config, repo);
const checker = new Checker({ repo, apple, gate, notifier, health, catalog, clock, config, topic });
const app = createApp({ repo, checker, catalog, notifier, config, topic, clock });

const server = serve({ fetch: app.fetch, port: config.port, hostname: config.host }, (info) => {
  log("startup", {
    dashboard: `http://${config.host}:${info.port}`,
    subscribe: `${config.ntfyServer}/${topic}`,
    interval: config.pollIntervalSeconds,
    location: config.appleLocation,
  });
});
checker.start();

function shutdown(signal: string) {
  log("shutdown", { signal });
  checker.stop();
  server.close(() => {
    db.close();
    process.exit(0);
  });
  setTimeout(() => process.exit(0), 3000).unref();
}

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
