import type { Hono } from "hono";
import type { Alert } from "../../db/repo.js";
import { ago } from "../../time.js";
import type { WebDeps } from "../deps.js";
import { redirectWithFlash, renderPage } from "../layout.js";
import { availabilityIndex, pairClass, pairTitle } from "../status.js";

const NO_DATA_AFTER_MS = 30 * 60_000;
const RECENT_SUCCESS_MS = 5 * 60_000;

export function registerAlerts(app: Hono, deps: WebDeps): void {
  const { repo, clock } = deps;

  app.get("/", (c) => {
    const now = clock.now();
    const alerts = repo.listAlerts();
    const stores = repo.listStores();
    const availability = availabilityIndex(repo.listAvailability());
    const status = deps.checker.status();
    const checkerHealthy = status.lastSuccessAt !== null && now - status.lastSuccessAt <= RECENT_SUCCESS_MS;

    const titleOf = (part: string) => {
      const item = repo.getCatalogItem(part);
      if (item) return item.title;
      const seen = stores.map((s) => availability(part, s.storeNumber)).find((r) => r?.productTitle);
      return seen?.productTitle || part;
    };

    const card = (alert: Alert) => {
      const alertStores = alert.storeNumbers.map((n) => stores.find((s) => s.storeNumber === n) ?? { storeNumber: n, name: n, city: "" });
      const lastPushed = Math.max(0, ...repo.listHits(alert.id).map((h) => h.lastNotifiedAt ?? 0)) || null;
      const hot = alert.partNumbers.some((p) => alert.storeNumbers.some((s) => availability(p, s)?.status === "available"));
      const silent = (part: string) =>
        checkerHealthy &&
        now - alert.createdAt >= NO_DATA_AFTER_MS &&
        !stores.some((s) => {
          const row = availability(part, s.storeNumber);
          return row && now - row.lastCheckedAt <= NO_DATA_AFTER_MS;
        });

      return (
        <article class={`alert-card${!alert.enabled ? " is-off" : hot ? " is-hot" : ""}`}>
          <div class="alert-card__head">
            <div>
              <h2 class="alert-card__name">{alert.name ?? alert.partNumbers.map(titleOf).join(", ")}</h2>
              <div class="alert-card__meta">
                {alert.enabled ? "Active" : "Paused"} · {lastPushed ? `Last pushed ${ago(lastPushed, now)}` : "Never pushed"}
              </div>
            </div>
            <div class="alert-card__actions">
              <form method="post" action={`/alerts/${alert.id}/toggle`} class="inline-form">
                <button class="button button--small button--quiet" type="submit">
                  {alert.enabled ? "Pause" : "Resume"}
                </button>
              </form>
              <form method="post" action={`/alerts/${alert.id}/delete`} class="inline-form">
                <button class="button button--small button--quiet" type="submit">
                  Delete
                </button>
              </form>
            </div>
          </div>
          <div class="scroll-x">
            <table class="matrix">
              <thead>
                <tr>
                  <th>Configuration</th>
                  {alertStores.map((s) => (
                    <th>{s.name}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {alert.partNumbers.map((part) => (
                  <tr>
                    <td>
                      {titleOf(part)} <span class="mono eyebrow">{part}</span>
                      {silent(part) ? (
                        <>
                          <br />
                          <span class="warning">Apple returns no data for this part</span>
                        </>
                      ) : null}
                    </td>
                    {alertStores.map((s) => {
                      const row = availability(part, s.storeNumber);
                      return (
                        <td>
                          <span class={`dot ${pairClass(row, now)}`} title={pairTitle(row)}></span>
                        </td>
                      );
                    })}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </article>
      );
    };

    return renderPage(c, deps, {
      title: "Alerts",
      active: "alerts",
      body: (
        <>
          <div class="title-row">
            <h1 class="title">Alerts</h1>
            <a class="button button--primary" href="/alerts/new">
              New alert
            </a>
          </div>
          {alerts.length === 0 ? (
            <section class="panel">
              <p class="empty">No alerts yet.</p>
              <p class="lede">
                Pick the exact iPhone you want and the stores you can get to. You get a push the moment Apple offers it for
                pickup there. <a href="/alerts/new">Create your first alert →</a>
              </p>
            </section>
          ) : (
            <div class="alerts">{alerts.map(card)}</div>
          )}
          <div class="legend" aria-label="Legend">
            <span>
              <span class="dot available legend-dot"></span> available for pickup
            </span>
            <span>
              <span class="dot unavailable legend-dot"></span> not available
            </span>
            <span>
              <span class="dot nodata legend-dot"></span> no data yet
            </span>
          </div>
        </>
      ),
    });
  });

  app.post("/alerts/:id/toggle", (c) => {
    const alert = repo.getAlert(Number(c.req.param("id")));
    if (!alert) return redirectWithFlash(c, "/", "Alert not found");
    repo.setAlertEnabled(alert.id, !alert.enabled);
    return redirectWithFlash(c, "/", alert.enabled ? "Alert paused" : "Alert resumed");
  });

  app.post("/alerts/:id/delete", (c) => {
    const alert = repo.getAlert(Number(c.req.param("id")));
    if (!alert) return redirectWithFlash(c, "/", "Alert not found");
    repo.deleteAlert(alert.id);
    return redirectWithFlash(c, "/", "Alert deleted");
  });
}
