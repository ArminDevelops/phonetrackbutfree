import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { Hono } from "hono";
import type { WebDeps } from "./deps.js";
import { HealthPill } from "./layout.js";
import { registerAlerts } from "./pages/alerts.js";
import { registerNewAlert } from "./pages/new-alert.js";
import { registerSettings } from "./pages/settings.js";

export type { WebDeps } from "./deps.js";

const require = createRequire(import.meta.url);

function loadAssets() {
  return {
    css: readFileSync(new URL("../../public/styles.css", import.meta.url), "utf8"),
    htmx: readFileSync(require.resolve("htmx.org/dist/htmx.min.js"), "utf8"),
  };
}

export function createApp(deps: WebDeps): Hono {
  const app = new Hono();
  const assets = loadAssets();

  app.get("/static/styles.css", (c) =>
    c.body(assets.css, 200, { "content-type": "text/css; charset=utf-8", "cache-control": "no-cache" }),
  );
  app.get("/static/htmx.min.js", (c) =>
    c.body(assets.htmx, 200, { "content-type": "text/javascript; charset=utf-8", "cache-control": "max-age=86400" }),
  );
  app.get("/partials/health", (c) => c.html(<HealthPill status={deps.checker.status()} now={deps.clock.now()} />));
  app.get("/api/status", (c) => c.json(deps.checker.status()));

  registerAlerts(app, deps);
  registerNewAlert(app, deps);
  registerSettings(app, deps);
  return app;
}
