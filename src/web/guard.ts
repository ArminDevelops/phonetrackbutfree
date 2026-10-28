import type { MiddlewareHandler } from "hono";
import { basicAuth } from "hono/basic-auth";
import type { Config } from "../config.js";

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);
/** Answered before any other check so Docker / nginx can probe liveness without credentials. */
export const HEALTH_PATH = "/healthz";

/**
 * The dashboard trusts only the host names it was told about:
 * - requests must name an allowed host (blocks DNS rebinding);
 * - state-changing requests must not come from another website (blocks CSRF);
 * - with DASHBOARD_USER/PASSWORD set, every page needs basic auth.
 */
export function guard(config: Pick<Config, "allowedHosts" | "dashboardUser" | "dashboardPassword">): MiddlewareHandler {
  const allowed = new Set(config.allowedHosts);
  const auth =
    config.dashboardUser && config.dashboardPassword
      ? basicAuth({ username: config.dashboardUser, password: config.dashboardPassword, realm: "Abholbereit" })
      : null;

  return async (c, next) => {
    const url = new URL(c.req.url);
    if (!allowed.has(url.hostname.replace(/^\[(.*)\]$/, "$1"))) return c.text("Forbidden host", 403);

    if (!SAFE_METHODS.has(c.req.method)) {
      if (c.req.header("sec-fetch-site") === "cross-site") return c.text("Cross-site request blocked", 403);
      const origin = c.req.header("origin");
      if (origin === "null" || (origin && new URL(origin).host !== url.host)) {
        return c.text("Cross-site request blocked", 403);
      }
    }

    if (auth && url.pathname !== HEALTH_PATH) return auth(c, next);
    await next();
  };
}
