import { parseLocatorMeta } from "../../src/apple/catalog.js";
import type { Repo } from "../../src/db/repo.js";
import { FAMILIES } from "./apple.js";
import { fixtureJson } from "./fixtures.js";

/** Seeds the repo with the recorded Swiss catalog (all six families, or a subset). */
export function seedCatalog(repo: Repo, families: string[] = FAMILIES, now = 0): void {
  families.forEach((family, i) => {
    repo.upsertCatalogItems(parseLocatorMeta(fixtureJson(`product-locator-meta-${family}.json`), family, i)!, now);
  });
}
