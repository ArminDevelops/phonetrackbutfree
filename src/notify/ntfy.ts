import { buyLink, imageUrl } from "../apple/catalog.js";
import type { Observation, StoreInfo } from "../apple/types.js";
import type { AlertMatch } from "../core/evaluate.js";
import type { CatalogRow } from "../db/repo.js";
import { formatDuration, formatTime } from "../time.js";

export interface NtfyAction {
  action: "view";
  label: string;
  url: string;
}

export interface NtfyMessage {
  topic: string;
  title: string;
  message: string;
  priority: 1 | 2 | 3 | 4 | 5;
  tags: string[];
  click?: string;
  actions?: NtfyAction[];
  attach?: string;
  /** Lets the ntfy apps show the extension-less Apple image URL inline as a PNG. */
  filename?: string;
}

export interface Lookup {
  item(partNumber: string): CatalogRow | undefined;
  store(storeNumber: string): StoreInfo | undefined;
}

export type HealthEvent =
  | { kind: "degraded"; since: number; reason: string }
  | { kind: "recovered"; downMs: number }
  | { kind: "resumed"; pausedMs: number };

export type SendResult = { ok: true } | { ok: false; error: string };

export interface Notifier {
  send(msg: NtfyMessage): Promise<SendResult>;
}

export function buildRestockMessage(topic: string, match: AlertMatch, lookup: Lookup): NtfyMessage {
  const byPart = new Map<string, Observation[]>();
  for (const o of match.observations) byPart.set(o.partNumber, [...(byPart.get(o.partNumber) ?? []), o]);

  const parts = [...byPart.entries()].map(([partNumber, observations]) => {
    const item = lookup.item(partNumber);
    const stores = observations
      .map((o) => {
        const store = lookup.store(o.storeNumber);
        return store ? `${store.name} (${store.city})` : o.storeNumber;
      })
      .join(", ");
    return {
      item,
      title: item?.title ?? (observations[0]!.productTitle || partNumber),
      link: item?.productLink ?? buyLink(partNumber),
      line: `${stores} — ${observations[0]!.quote}`,
    };
  });

  const first = parts[0]!;
  if (parts.length === 1) {
    return {
      topic,
      title: `${first.title} available`,
      message: first.line,
      priority: 5,
      tags: ["iphone"],
      click: first.link,
      actions: [{ action: "view", label: "Buy now", url: first.link }],
      ...(first.item?.imageKey ? { attach: imageUrl(first.item.imageKey), filename: `${first.item.imageKey}.png` } : {}),
    };
  }

  return {
    topic,
    title: `${parts.length} configs available${match.alert.name ? ` · ${match.alert.name}` : ""}`,
    message: parts.map((p) => `${p.title}: ${p.line}`).join("\n"),
    priority: 5,
    tags: ["iphone"],
    click: first.link,
    actions: parts.slice(0, 2).map((p) => ({
      action: "view" as const,
      label: `Buy ${p.item?.capacityLabel ?? ""} ${p.item?.colorLabel ?? ""}`.trim(),
      url: p.link,
    })),
  };
}

export function buildHealthMessage(topic: string, event: HealthEvent): NtfyMessage {
  switch (event.kind) {
    case "degraded":
      return {
        topic,
        title: "Stock checker can't reach Apple",
        message: `Failing since ${formatTime(event.since)} (${event.reason}). Backing off and retrying.`,
        priority: 3,
        tags: ["warning"],
      };
    case "recovered":
      return {
        topic,
        title: "Stock checker recovered",
        message: `Checking again after ${formatDuration(event.downMs)} of failures.`,
        priority: 2,
        tags: ["white_check_mark"],
      };
    case "resumed":
      return {
        topic,
        title: "Stock checker resumed",
        message: `Checking resumed after a ${formatDuration(event.pausedMs)} pause (Mac was asleep or the checker wasn't running).`,
        priority: 2,
        tags: ["zzz"],
      };
  }
}

export function buildTestMessage(topic: string): NtfyMessage {
  return {
    topic,
    title: "Test notification",
    message: "ntfy is set up — restock alerts will arrive here.",
    priority: 3,
    tags: ["iphone"],
  };
}

export function createNtfyNotifier(opts: {
  server: string;
  token: string | null;
  fetch?: typeof fetch;
  timeoutMs?: number;
}): Notifier {
  const fetchFn = opts.fetch ?? fetch;
  const timeoutMs = opts.timeoutMs ?? 10_000;
  return {
    async send(msg) {
      try {
        const headers: Record<string, string> = { "content-type": "application/json" };
        if (opts.token) headers.authorization = `Bearer ${opts.token}`;
        const response = await fetchFn(`${opts.server}/`, {
          method: "POST",
          headers,
          body: JSON.stringify(msg),
          signal: AbortSignal.timeout(timeoutMs),
        });
        if (!response.ok) {
          const body = await response.text().catch(() => "");
          return { ok: false, error: `HTTP ${response.status}: ${body.slice(0, 200)}` };
        }
        await response.body?.cancel();
        return { ok: true };
      } catch (error) {
        return { ok: false, error: error instanceof Error ? error.message : String(error) };
      }
    },
  };
}
