import type { AppleClient } from "../apple/client.js";
import { MAX_PARTS_PER_REQUEST } from "../apple/pickup.js";
import type { Config } from "../config.js";
import type { Repo } from "../db/repo.js";
import { log } from "../log.js";
import { buildHealthMessage, buildRestockMessage, type HealthEvent, type Lookup, type Notifier } from "../notify/ntfy.js";
import type { Clock } from "../time.js";
import { planBatches } from "./batching.js";
import type { CatalogService } from "./catalog-service.js";
import { applyObservations, evaluateAlerts, markNotified, type StateChange } from "./evaluate.js";
import { jitter, type AppleGate, type FailureKind } from "./gate.js";
import type { CycleOutcome, HealthMonitor } from "./health.js";

export interface CheckerDeps {
  repo: Repo;
  apple: AppleClient;
  gate: AppleGate;
  notifier: Notifier;
  health: HealthMonitor;
  catalog: CatalogService;
  clock: Clock;
  config: Config;
  topic: string;
  random?: () => number;
  sleep?: (ms: number) => Promise<void>;
  fetch?: typeof fetch;
}

export interface CycleReport {
  outcome: CycleOutcome | { kind: "skipped" };
  requests: number;
  observations: number;
  changes: StateChange[];
  pushes: number;
}

export interface CheckerStatus {
  state: "starting" | "ok" | "blocked" | "error";
  lastSuccessAt: number | null;
  lastCycleAt: number | null;
  backoffUntil: number | null;
  lastFailure: { kind: FailureKind; message: string; at: number } | null;
  failingSince: number | null;
  requestsLastHour: number;
  nextRunAt: number | null;
  watchedParts: number;
}

const CATALOG_MAX_AGE_MS = 24 * 3_600_000;
const HEARTBEAT_EVERY_MS = 5 * 60_000;
const LATE_WAKEUP_MS = 60_000;

/** Runs the polling loop: plan batches, ask Apple, record state, push alerts and health. */
export class Checker {
  private readonly random: () => number;
  private readonly sleep: (ms: number) => Promise<void>;
  private cursor = 0;
  private ranCycle = false;
  private lastHeartbeatAt: number | null = null;
  private running = false;
  private timer: NodeJS.Timeout | null = null;
  private wake: (() => void) | null = null;
  private nextRunAt: number | null = null;

  constructor(private readonly deps: CheckerDeps) {
    this.random = deps.random ?? Math.random;
    this.sleep = deps.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  }

  async runCycle(): Promise<CycleReport> {
    const { repo, apple, gate, health, clock, config } = this.deps;
    const startedAt = clock.now();
    const report: CycleReport = { outcome: { kind: "skipped" }, requests: 0, observations: 0, changes: [], pushes: 0 };

    const pause = health.checkPause(startedAt);
    if (pause) await this.pushHealth(pause);

    if (!gate.isOpen()) return report;

    const fill = repo.listCatalog({ activeOnly: true }).map((i) => i.partNumber);
    const plan = planBatches(repo.watchedParts(), fill, this.cursor, MAX_PARTS_PER_REQUEST);
    this.cursor = plan.nextCursor;
    if (plan.batches.length === 0) return report;

    let failure: CycleOutcome | null = null;
    let anySuccess = false;
    for (const [i, batch] of plan.batches.entries()) {
      if (i > 0) await this.sleep(2000 + this.random() * 2000);
      gate.countRequest();
      report.requests++;
      const result = await apple.pickup(batch, config.appleLocation);

      if (result.kind === "blocked") {
        gate.reportFailure("blocked", `HTTP ${result.httpStatus}`);
        failure = { kind: "blocked", message: `blocked, HTTP ${result.httpStatus}` };
        break;
      }
      if (result.kind === "error") {
        gate.reportFailure("error", result.message);
        failure = { kind: "error", message: result.message };
        break;
      }
      if (result.kind === "empty") {
        log("batch.empty", { parts: batch.length, message: result.message });
        continue;
      }

      anySuccess = true;
      const knownStores = repo.listStores().length;
      if (result.stores.length < knownStores) {
        log("stores.missing", { got: result.stores.map((s) => s.storeNumber).join(","), known: knownStores });
      }
      repo.upsertStores(result.stores);
      const now = clock.now();
      const changes = applyObservations(repo, result.observations, now);
      for (const c of changes) log("stock.changed", { ...c });
      report.changes.push(...changes);
      report.observations += result.observations.length;
      report.pushes += await this.pushMatches(evaluateAlerts(repo, result.observations, now, config.renotifyCooldownMinutes * 60_000));
    }

    if (failure) {
      report.outcome = failure;
    } else if (anySuccess) {
      gate.reportSuccess();
      report.outcome = { kind: "success" };
    } else {
      gate.reportFailure("error", "Apple returned no store data");
      report.outcome = { kind: "error", message: "Apple returned no store data" };
    }

    this.ranCycle = true;
    const healthEvent = health.recordCycle(report.outcome, clock.now());
    if (healthEvent) await this.pushHealth(healthEvent);
    if (report.outcome.kind === "success") this.heartbeat();

    log("cycle", {
      outcome: report.outcome.kind,
      message: "message" in report.outcome ? report.outcome.message : undefined,
      requests: report.requests,
      observations: report.observations,
      changes: report.changes.length,
      pushes: report.pushes,
      ms: clock.now() - startedAt,
    });
    return report;
  }

  nextDelayMs(): number {
    const { gate, clock, config, repo } = this.deps;
    const now = clock.now();
    if (gate.backoffUntil !== null && gate.backoffUntil > now) return gate.backoffUntil - now;
    const batches = Math.max(1, Math.ceil(repo.watchedParts().length / MAX_PARTS_PER_REQUEST));
    const seconds = Math.max(config.pollIntervalSeconds, Math.ceil((batches * 3600) / config.maxRequestsPerHour));
    return jitter(seconds * 1000, this.random);
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    void this.loop();
  }

  stop(): void {
    this.running = false;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.nextRunAt = null;
    this.wake?.();
  }

  status(): CheckerStatus {
    const { gate, health, repo } = this.deps;
    const snapshot = health.snapshot();
    const failure = gate.lastFailure;
    let state: CheckerStatus["state"] = "ok";
    if (!this.ranCycle) state = "starting";
    else if (gate.consecutiveFailures > 0 && failure) state = failure.kind;
    return {
      state,
      lastSuccessAt: snapshot.lastSuccessAt,
      lastCycleAt: snapshot.lastCycleAt,
      backoffUntil: gate.backoffUntil,
      lastFailure: failure,
      failingSince: snapshot.failingSince,
      requestsLastHour: gate.requestsLastHour(),
      nextRunAt: this.nextRunAt,
      watchedParts: repo.watchedParts().length,
    };
  }

  private async loop(): Promise<void> {
    const { catalog, clock } = this.deps;
    while (this.running) {
      try {
        await catalog.refreshIfStale(CATALOG_MAX_AGE_MS);
      } catch (error) {
        log("catalog.crashed", { error });
      }
      if (!this.running) break;
      try {
        await this.runCycle();
      } catch (error) {
        log("cycle.crashed", { error });
      }
      if (!this.running) break;

      const delay = this.nextDelayMs();
      const plannedAt = clock.now() + delay;
      this.nextRunAt = plannedAt;
      await new Promise<void>((resolve) => {
        this.wake = resolve;
        this.timer = setTimeout(resolve, delay);
      });
      this.wake = null;
      const late = clock.now() - plannedAt;
      if (this.running && late > LATE_WAKEUP_MS) log("loop.gap", { lateMs: late });
    }
  }

  private lookup(): Lookup {
    const { repo } = this.deps;
    const stores = repo.listStores();
    return {
      item: (partNumber) => repo.getCatalogItem(partNumber),
      store: (storeNumber) => stores.find((s) => s.storeNumber === storeNumber),
    };
  }

  private async pushMatches(matches: ReturnType<typeof evaluateAlerts>): Promise<number> {
    const { repo, notifier, clock, topic } = this.deps;
    let pushed = 0;
    for (const match of matches) {
      const message = buildRestockMessage(topic, match, this.lookup());
      const result = await notifier.send(message);
      const now = clock.now();
      repo.logNotification({
        at: now,
        kind: "restock",
        alertId: match.alert.id,
        title: message.title,
        ok: result.ok,
        error: result.ok ? null : result.error,
      });
      log("push.restock", { alert: match.alert.id, title: message.title, ok: result.ok, error: result.ok ? undefined : result.error });
      if (result.ok) {
        markNotified(repo, match, now);
        pushed++;
      }
    }
    return pushed;
  }

  private async pushHealth(event: HealthEvent): Promise<void> {
    const { repo, notifier, clock, topic } = this.deps;
    const message = buildHealthMessage(topic, event);
    const result = await notifier.send(message);
    repo.logNotification({
      at: clock.now(),
      kind: "health",
      alertId: null,
      title: message.title,
      ok: result.ok,
      error: result.ok ? null : result.error,
    });
    log("push.health", { kind: event.kind, ok: result.ok, error: result.ok ? undefined : result.error });
  }

  private heartbeat(): void {
    const { config, clock } = this.deps;
    if (!config.heartbeatUrl) return;
    const now = clock.now();
    if (this.lastHeartbeatAt !== null && now - this.lastHeartbeatAt < HEARTBEAT_EVERY_MS) return;
    this.lastHeartbeatAt = now;
    const fetchFn = this.deps.fetch ?? fetch;
    void fetchFn(config.heartbeatUrl, { signal: AbortSignal.timeout(10_000) })
      .then((response) => response.body?.cancel())
      .catch((error) => log("heartbeat.failed", { error }));
  }
}
