import type { Hono } from "hono";
import type { CatalogRow } from "../../db/repo.js";
import type { WebDeps } from "../deps.js";
import { renderPage } from "../layout.js";
import { availabilityIndex, capacityGb, pairClass, pairTitle } from "../status.js";

export function registerStock(app: Hono, deps: WebDeps): void {
  const { repo, clock } = deps;

  function Grid() {
    const now = clock.now();
    const catalog = repo.listCatalog({ activeOnly: true });
    const stores = repo.listStores();
    const availability = availabilityIndex(repo.listAvailability());

    if (catalog.length === 0) {
      return (
        <div id="stock-grid" hx-get="/partials/stock" hx-trigger="every 15s" hx-swap="outerHTML">
          <p class="empty">Catalog is still loading — refresh in a minute.</p>
        </div>
      );
    }

    const models = new Map<string, CatalogRow[]>();
    for (const item of catalog) models.set(item.modelName, [...(models.get(item.modelName) ?? []), item]);
    const somewhere = catalog.filter((i) => stores.some((s) => availability(i.partNumber, s.storeNumber)?.status === "available"));

    return (
      <div id="stock-grid" hx-get="/partials/stock" hx-trigger="every 15s" hx-swap="outerHTML">
        <p class="summary">
          <strong>{somewhere.length}</strong> of {catalog.length} configurations available somewhere
        </p>
        {[...models.entries()].map(([model, items]) => {
          const rows = [...items].sort((a, b) => capacityGb(a) - capacityGb(b) || a.colorLabel.localeCompare(b.colorLabel, "de"));
          const hot = rows.filter((i) => stores.some((s) => availability(i.partNumber, s.storeNumber)?.status === "available"));
          return (
            <section class="model-block">
              <h2>
                {model} <span class="count">{hot.length}/{rows.length} available</span>
              </h2>
              <div class="scroll-x">
                <table class="board">
                  <thead>
                    <tr>
                      <th>Configuration</th>
                      {stores.map((s) => (
                        <th class="store">
                          {s.name}
                          <small>{s.city}</small>
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map((item) => (
                      <tr>
                        <td class="config">
                          {item.isCustom ? item.title : `${item.colorLabel} · ${item.capacityLabel}`}
                          {item.priceChf ? <span class="price">CHF {item.priceChf}</span> : null}
                        </td>
                        {stores.map((s) => {
                          const row = availability(item.partNumber, s.storeNumber);
                          const cls = pairClass(row, now);
                          return (
                            <td class={`cell ${cls}`} title={pairTitle(row)} data-part={item.partNumber} data-store={s.storeNumber}>
                              {row ? (row.status === "available" ? "available" : "—") : "no data"}
                            </td>
                          );
                        })}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </section>
          );
        })}
      </div>
    );
  }

  app.get("/stock", (c) =>
    renderPage(c, deps, {
      title: "Live stock",
      active: "stock",
      body: (
        <>
          <h1 class="title">Live stock</h1>
          <div class="legend">
            <span>In-store pickup at each Swiss Apple Store. Refreshes on its own; faded cells are older than 10 minutes.</span>
          </div>
          <Grid />
        </>
      ),
    }),
  );

  app.get("/partials/stock", (c) => c.html(<Grid />));
}
