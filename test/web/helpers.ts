import type { CheckerStatus } from "../../src/core/checker.js";
import type { CustomLookup } from "../../src/core/catalog-service.js";
import { loadConfig } from "../../src/config.js";
import { openDb } from "../../src/db/db.js";
import { Repo } from "../../src/db/repo.js";
import type { NtfyMessage, SendResult } from "../../src/notify/ntfy.js";
import { createApp } from "../../src/web/app.js";
import { FakeClock } from "../helpers/clock.js";

export const TOPIC = "apple-ch-testtopic";

export function okStatus(now: number, overrides: Partial<CheckerStatus> = {}): CheckerStatus {
  return {
    state: "ok",
    lastSuccessAt: now - 12_000,
    lastCycleAt: now - 12_000,
    backoffUntil: null,
    lastFailure: null,
    failingSince: null,
    requestsLastHour: 42,
    nextRunAt: now + 18_000,
    watchedParts: 0,
    ...overrides,
  };
}

export function makeTestApp() {
  const clock = new FakeClock();
  const repo = new Repo(openDb(":memory:"));
  const config = loadConfig({});
  let status = okStatus(clock.now());
  const sent: NtfyMessage[] = [];
  let sendResult: SendResult = { ok: true };
  let lookupResult: CustomLookup = { kind: "unknown" };
  const lookups: { partNumber: string; location: string }[] = [];
  let refreshes = 0;

  const app = createApp({
    repo,
    config,
    topic: TOPIC,
    clock,
    checker: { status: () => status },
    notifier: {
      async send(msg) {
        sent.push(msg);
        return sendResult;
      },
    },
    catalog: {
      async refresh() {
        refreshes++;
        return { ok: true, families: [] };
      },
      async lookupCustomPart(partNumber, location) {
        lookups.push({ partNumber, location });
        if (lookupResult.kind === "added") repo.addCustomPart(lookupResult.partNumber, lookupResult.title, clock.now());
        return lookupResult;
      },
    },
  });

  return {
    app,
    repo,
    clock,
    config,
    sent,
    lookups,
    get refreshes() {
      return refreshes;
    },
    setStatus(s: CheckerStatus) {
      status = s;
    },
    setSendResult(r: SendResult) {
      sendResult = r;
    },
    setLookupResult(r: CustomLookup) {
      lookupResult = r;
    },
    post(path: string, form: Record<string, string | string[]>) {
      const body = new URLSearchParams();
      for (const [key, value] of Object.entries(form)) {
        for (const v of Array.isArray(value) ? value : [value]) body.append(key, v);
      }
      return app.request(path, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: body.toString(),
      });
    },
  };
}

/** Response body with the few HTML entities hono/jsx emits decoded, for text assertions. */
export async function pageText(res: Response): Promise<string> {
  return (await res.text()).replace(/&#39;/g, "'").replace(/&quot;/g, '"').replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
}
