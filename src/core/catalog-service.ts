import { familyFromSlug, normalizePartNumber, parseLocatorMeta, parseModelSlugs } from "../apple/catalog.js";
import type { AppleClient } from "../apple/client.js";
import type { CatalogItem } from "../apple/types.js";
import type { Repo } from "../db/repo.js";
import { log } from "../log.js";
import type { Clock } from "../time.js";
import type { AppleGate } from "./gate.js";

export type CustomLookup =
  | { kind: "added"; partNumber: string; title: string }
  | { kind: "invalid" }
  | { kind: "unknown" }
  | { kind: "backoff" }
  | { kind: "error"; message: string };

export interface CatalogRefreshResult {
  ok: boolean;
  families: { family: string; count: number | null }[];
}

const REFRESHED_AT = "catalog_refreshed_at";
/** After a failed or interrupted refresh, wait this long before trying again on our own. */
const RETRY_AFTER_MS = 30 * 60_000;

export class CatalogService {
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly spacingMs: number;
  private lastAttemptAt: number | null = null;
  private inFlight: Promise<CatalogRefreshResult> | null = null;

  constructor(
    private readonly deps: {
      apple: AppleClient;
      repo: Repo;
      gate: AppleGate;
      clock: Clock;
      sleep?: (ms: number) => Promise<void>;
      spacingMs?: number;
    },
  ) {
    this.sleep = deps.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.spacingMs = deps.spacingMs ?? 2500;
  }

  /** One refresh at a time: a second caller (button, daily timer) joins the running one. */
  refresh(): Promise<CatalogRefreshResult> {
    this.inFlight ??= this.runRefresh().finally(() => {
      this.inFlight = null;
    });
    return this.inFlight;
  }

  private async runRefresh(): Promise<CatalogRefreshResult> {
    const { apple, repo, gate, clock } = this.deps;
    if (!gate.isOpen()) return { ok: false, families: [] };

    this.lastAttemptAt = clock.now();
    gate.countRequest();
    const index = await apple.get("buy-iphone");
    if (index.kind === "blocked") gate.reportFailure("blocked", `HTTP ${index.httpStatus}`);
    if (index.kind !== "ok") {
      log("catalog.index_failed", { result: index });
      return { ok: false, families: [] };
    }

    const slugs = parseModelSlugs(index.text);
    if (slugs.length === 0) {
      log("catalog.no_models");
      return { ok: false, families: [] };
    }

    const families: CatalogRefreshResult["families"] = [];
    const seen = new Set<string>();
    let interrupted = false;
    for (const [sortOrder, slug] of slugs.entries()) {
      const family = familyFromSlug(slug);
      await this.sleep(this.spacingMs);
      if (!gate.isOpen()) {
        // The checker (or another call) got blocked meanwhile: send nothing more during the backoff.
        log("catalog.gate_closed", { family });
        interrupted = true;
        break;
      }
      gate.countRequest();
      const response = await apple.get(`product-locator-meta?family=${family}`);
      if (response.kind === "blocked") {
        gate.reportFailure("blocked", `HTTP ${response.httpStatus}`);
        families.push({ family, count: null });
        log("catalog.blocked", { family, status: response.httpStatus });
        interrupted = true;
        break;
      }
      let items: CatalogItem[] | null = null;
      if (response.kind === "ok") {
        try {
          items = parseLocatorMeta(JSON.parse(response.text), family, sortOrder);
        } catch {
          items = null;
        }
      }
      if (!items) {
        families.push({ family, count: null });
        log("catalog.family_failed", { family, result: response.kind === "error" ? response.message : "no products" });
        continue;
      }
      const fresh = items.filter((i) => !seen.has(i.partNumber));
      fresh.forEach((i) => seen.add(i.partNumber));
      repo.upsertCatalogItems(fresh, clock.now());
      repo.deactivateMissing(family, fresh.map((i) => i.partNumber), clock.now());
      families.push({ family, count: fresh.length });
    }

    const ok = families.some((f) => f.count !== null);
    // An interrupted refresh is not "fresh": retry it once the gate reopens.
    if (ok && !interrupted) repo.setSetting(REFRESHED_AT, String(clock.now()));
    log("catalog.refreshed", { ok, families: families.map((f) => `${f.family}:${f.count ?? "failed"}`).join(",") });
    return { ok, families };
  }

  async refreshIfStale(maxAgeMs: number): Promise<void> {
    const { repo, clock } = this.deps;
    const hasCatalog = repo.listCatalog({ activeOnly: true }).some((i) => !i.isCustom);
    const refreshedAt = Number(repo.getSetting(REFRESHED_AT) ?? 0);
    if (hasCatalog && clock.now() - refreshedAt < maxAgeMs) return;
    if (this.lastAttemptAt !== null && clock.now() - this.lastAttemptAt < RETRY_AFTER_MS) return;
    await this.refresh();
  }

  async lookupCustomPart(input: string, location: string): Promise<CustomLookup> {
    const { apple, repo, gate, clock } = this.deps;
    const partNumber = normalizePartNumber(input);
    if (!partNumber) return { kind: "invalid" };
    if (!gate.isOpen()) return { kind: "backoff" };

    gate.countRequest();
    const result = await apple.pickup([partNumber], location);
    switch (result.kind) {
      case "success": {
        const observation = result.observations.find((o) => o.partNumber === partNumber);
        if (!observation) return { kind: "unknown" };
        const title = observation.productTitle || partNumber;
        repo.addCustomPart(partNumber, title, clock.now());
        return { kind: "added", partNumber, title };
      }
      case "empty":
        return { kind: "unknown" };
      case "blocked":
        gate.reportFailure("blocked", `HTTP ${result.httpStatus}`);
        return { kind: "backoff" };
      case "error":
        return { kind: "error", message: result.message };
    }
  }
}
