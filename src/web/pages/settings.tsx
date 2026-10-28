import type { Hono } from "hono";
import { raw } from "hono/html";
import QRCode from "qrcode";
import { log } from "../../log.js";
import { buildTestMessage } from "../../notify/ntfy.js";
import { ago, formatDateTime, formatTime } from "../../time.js";
import type { WebDeps } from "../deps.js";
import { redirectWithFlash, renderPage } from "../layout.js";

function Row(props: { label: string; children: unknown }) {
  return (
    <div class="kv__row">
      <dt>{props.label}</dt>
      <dd>{props.children}</dd>
    </div>
  );
}

export function registerSettings(app: Hono, deps: WebDeps): void {
  const { repo, config, topic, clock } = deps;

  app.get("/settings", async (c) => {
    const now = clock.now();
    const status = deps.checker.status();
    const subscribeUrl = `${config.ntfyServer}/${topic}`;
    const qr = await QRCode.toString(subscribeUrl, { type: "svg", margin: 1, color: { dark: "#141414", light: "#00000000" } });
    const refreshedAt = Number(repo.getSetting("catalog_refreshed_at") ?? 0) || null;
    const catalog = repo.listCatalog({ activeOnly: true });
    const notifications = repo.listNotifications(20);
    const when = (ms: number | null) => (ms ? `${formatDateTime(ms)} (${ago(ms, now)})` : "—");

    return renderPage(c, deps, {
      title: "Settings",
      active: "settings",
      body: (
        <>
          <h1 class="title">Settings</h1>

          <section class="panel panel--split">
            <div>
              <h2 class="panel__title">Notifications</h2>
              <p class="lede">
                Install the ntfy app on your phone and subscribe to this topic — or scan the code. Anyone who knows the topic
                can read it, so keep it to yourself.
              </p>
              <dl class="kv">
                <Row label="Server">{config.ntfyServer}</Row>
                <Row label="Topic">
                  <code class="mono">{topic}</code>
                </Row>
                <Row label="Subscribe">
                  <a href={subscribeUrl} class="mono" target="_blank" rel="noreferrer">
                    {subscribeUrl}
                  </a>
                </Row>
              </dl>
              <form method="post" action="/settings/test-notification">
                <button class="button button--primary" type="submit">
                  Send test notification
                </button>
              </form>
            </div>
            <figure class="qr" aria-label="QR code for the ntfy subscription">
              {raw(qr)}
              <figcaption>Scan with the ntfy app</figcaption>
            </figure>
          </section>

          <section class="panel">
            <h2 class="panel__title">Checker</h2>
            <dl class="kv kv--grid">
              <Row label="State">{status.state}</Row>
              <Row label="Last success">{when(status.lastSuccessAt)}</Row>
              <Row label="Next check">{status.nextRunAt ? formatTime(status.nextRunAt) : "—"}</Row>
              <Row label="Backing off until">{status.backoffUntil ? formatTime(status.backoffUntil) : "—"}</Row>
              <Row label="Failing since">{status.failingSince ? formatTime(status.failingSince) : "—"}</Row>
              <Row label="Last failure">
                {status.lastFailure ? `${status.lastFailure.message} at ${formatDateTime(status.lastFailure.at)}` : "—"}
              </Row>
              <Row label="Requests last hour">
                {status.requestsLastHour} / {config.maxRequestsPerHour}
              </Row>
              <Row label="Watched parts">{status.watchedParts}</Row>
              <Row label="Interval">{config.pollIntervalSeconds} s ± 20 %</Row>
              <Row label="Search location">{config.appleLocation}</Row>
            </dl>
          </section>

          <section class="panel">
            <h2 class="panel__title">Catalog</h2>
            <dl class="kv kv--grid">
              <Row label="Configurations">{catalog.length}</Row>
              <Row label="Last refreshed">{when(refreshedAt)}</Row>
            </dl>
            <form method="post" action="/settings/refresh-catalog">
              <button class="button" type="submit">
                Refresh catalog now
              </button>
            </form>
          </section>

          <section class="panel">
            <h2 class="panel__title">Recent notifications</h2>
            {notifications.length === 0 ? (
              <p class="empty">Nothing sent yet.</p>
            ) : (
              <table class="table">
                <thead>
                  <tr>
                    <th>Time</th>
                    <th>Kind</th>
                    <th>Title</th>
                    <th>Result</th>
                  </tr>
                </thead>
                <tbody>
                  {notifications.map((n) => (
                    <tr>
                      <td class="mono">{formatDateTime(n.at)}</td>
                      <td>{n.kind}</td>
                      <td>{n.title}</td>
                      <td class={n.ok ? "ok" : "bad"}>{n.ok ? "sent" : n.error}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </section>
        </>
      ),
    });
  });

  app.post("/settings/test-notification", async (c) => {
    const message = buildTestMessage(topic);
    const result = await deps.notifier.send(message);
    repo.logNotification({
      at: clock.now(),
      kind: "test",
      alertId: null,
      title: message.title,
      ok: result.ok,
      error: result.ok ? null : result.error,
    });
    return redirectWithFlash(c, "/settings", result.ok ? "Test notification sent" : `Test notification failed: ${result.error}`);
  });

  app.post("/settings/refresh-catalog", (c) => {
    deps.catalog.refresh().catch((error) => log("catalog.manual_refresh_failed", { error }));
    return redirectWithFlash(c, "/settings", "Catalog refresh started — reload in a minute");
  });
}
