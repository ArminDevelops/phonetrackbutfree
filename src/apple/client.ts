import { APPLE_BASE, APPLE_USER_AGENT, buildPickupPath, parsePickupJson } from "./pickup.js";
import type { BatchResult } from "./types.js";

export type AppleResponse =
  | { kind: "ok"; text: string }
  | { kind: "blocked"; httpStatus: number }
  | { kind: "error"; message: string };

export interface AppleClient {
  /** GET `APPLE_BASE + path`. */
  get(path: string): Promise<AppleResponse>;
  pickup(parts: string[], location: string): Promise<BatchResult>;
}

/** Status codes Apple uses when it rate-limits or bot-blocks us. */
const BLOCKED_STATUSES = new Set([541, 403, 429]);

export function createAppleClient(opts: { fetch?: typeof fetch; timeoutMs?: number } = {}): AppleClient {
  const fetchFn = opts.fetch ?? fetch;
  const timeoutMs = opts.timeoutMs ?? 15_000;

  async function get(path: string): Promise<AppleResponse> {
    try {
      const response = await fetchFn(APPLE_BASE + path, {
        headers: { "user-agent": APPLE_USER_AGENT, accept: "application/json" },
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (BLOCKED_STATUSES.has(response.status)) {
        await response.body?.cancel();
        return { kind: "blocked", httpStatus: response.status };
      }
      if (!response.ok) {
        await response.body?.cancel();
        return { kind: "error", message: `HTTP ${response.status}` };
      }
      return { kind: "ok", text: await response.text() };
    } catch (error) {
      if (error instanceof Error && error.name === "TimeoutError") {
        return { kind: "error", message: `timeout after ${timeoutMs} ms` };
      }
      return { kind: "error", message: error instanceof Error ? error.message : String(error) };
    }
  }

  return {
    get,
    async pickup(parts, location) {
      const response = await get(buildPickupPath(parts, location));
      return response.kind === "ok" ? parsePickupJson(response.text) : response;
    },
  };
}
