import type { Config } from "../config.js";
import type { CatalogService } from "../core/catalog-service.js";
import type { CheckerStatus } from "../core/checker.js";
import type { Repo } from "../db/repo.js";
import type { Notifier } from "../notify/ntfy.js";
import type { Clock } from "../time.js";

export interface WebDeps {
  repo: Repo;
  checker: { status(): CheckerStatus };
  catalog: Pick<CatalogService, "refresh" | "lookupCustomPart">;
  notifier: Notifier;
  config: Config;
  topic: string;
  clock: Clock;
}
