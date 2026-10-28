import type { Hono } from "hono";
import { pairRestockDurations } from "../../core/restocks.js";
import { formatDateTime, formatDuration } from "../../time.js";
import type { WebDeps } from "../deps.js";
import { renderPage } from "../layout.js";

const LIMIT = 200;

export function registerRestocks(app: Hono, deps: WebDeps): void {
  const { repo } = deps;

  app.get("/restocks", (c) => {
    const events = repo.listEvents(LIMIT);
    const durations = pairRestockDurations(events);
    const stores = new Map(repo.listStores().map((s) => [s.storeNumber, s]));
    const title = (part: string) => repo.getCatalogItem(part)?.title ?? part;

    return renderPage(c, deps, {
      title: "Restocks",
      active: "restocks",
      body: (
        <>
          <h1 class="title">Restocks</h1>
          <p class="lede">Every time a configuration came back or sold out at a store, newest first. Useful for spotting Apple's restock rhythm.</p>
          <section class="panel">
            {events.length === 0 ? (
              <p class="empty">No restocks recorded yet. They appear here once the checker sees stock change.</p>
            ) : (
              <div class="scroll-x">
                <table class="table">
                  <thead>
                    <tr>
                      <th>Time</th>
                      <th>Configuration</th>
                      <th>Store</th>
                      <th>Change</th>
                      <th>Available for</th>
                    </tr>
                  </thead>
                  <tbody>
                    {events.map((e) => {
                      const store = stores.get(e.storeNumber);
                      const duration = durations.get(e.id);
                      return (
                        <tr>
                          <td class="mono">{formatDateTime(e.at)}</td>
                          <td>{title(e.partNumber)}</td>
                          <td>{store ? `${store.name}, ${store.city}` : e.storeNumber}</td>
                          <td class={`kind-${e.kind}`}>{e.kind === "restock" ? "Back in stock" : "Sold out"}</td>
                          <td class="mono">
                            {e.kind === "restock" ? (duration === null || duration === undefined ? "still available" : formatDuration(duration)) : ""}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </section>
        </>
      ),
    });
  });
}
