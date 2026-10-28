import type { MiddlewareHandler } from "hono";

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "[::1]", "::1"]);
const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

/**
 * The dashboard has no login, so it trusts only this Mac:
 * - while bound to loopback, requests must name a loopback host (blocks DNS rebinding);
 * - state-changing requests must not come from another website (blocks CSRF).
 */
export function localOnly(bindHost: string): MiddlewareHandler {
  const checkHost = LOOPBACK_HOSTS.has(bindHost);
  return async (c, next) => {
    const url = new URL(c.req.url);
    if (checkHost && !LOOPBACK_HOSTS.has(url.hostname)) return c.text("Forbidden host", 403);

    if (!SAFE_METHODS.has(c.req.method)) {
      if (c.req.header("sec-fetch-site") === "cross-site") return c.text("Cross-site request blocked", 403);
      const origin = c.req.header("origin");
      if (origin && origin !== "null" && new URL(origin).host !== url.host) {
        return c.text("Cross-site request blocked", 403);
      }
      if (origin === "null") return c.text("Cross-site request blocked", 403);
    }
    await next();
  };
}
