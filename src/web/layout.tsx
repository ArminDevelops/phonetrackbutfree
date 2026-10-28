import type { Context } from "hono";
import type { Child } from "hono/jsx";
import type { CheckerStatus } from "../core/checker.js";
import { ago, formatTime } from "../time.js";
import type { WebDeps } from "./deps.js";

export type NavKey = "alerts" | "stock" | "restocks" | "settings";

const NAV: { key: NavKey; href: string; label: string }[] = [
  { key: "alerts", href: "/", label: "Alerts" },
  { key: "stock", href: "/stock", label: "Live stock" },
  { key: "restocks", href: "/restocks", label: "Restocks" },
  { key: "settings", href: "/settings", label: "Settings" },
];

export function healthText(status: CheckerStatus, now: number): string {
  const retry = status.backoffUntil ? ` · retry ${formatTime(status.backoffUntil)}` : "";
  switch (status.state) {
    case "starting":
      return "Starting…";
    case "blocked":
      return `Blocked by Apple${retry}`;
    case "error":
      return `Error${retry}`;
    case "ok":
      return status.lastSuccessAt ? `Checking · last success ${ago(status.lastSuccessAt, now)}` : "Checking";
  }
}

export function HealthPill(props: { status: CheckerStatus; now: number }) {
  return (
    <div
      id="health"
      class={`pill pill--${props.status.state}`}
      hx-get="/partials/health"
      hx-trigger="every 10s"
      hx-swap="outerHTML"
      role="status"
    >
      <span class="pill__lamp" aria-hidden="true"></span>
      <span>{healthText(props.status, props.now)}</span>
    </div>
  );
}

export function Layout(props: {
  title: string;
  active: NavKey;
  flash?: string | undefined;
  status: CheckerStatus;
  now: number;
  children?: Child;
}) {
  return (
    <html lang="en">
      <head>
        <meta charset="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <title>{`${props.title} · Abholbereit`}</title>
        <link
          rel="icon"
          href="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32'%3E%3Crect width='32' height='32' rx='4' fill='%23d52b1e'/%3E%3Cpath d='M13 7h6v6h6v6h-6v6h-6v-6H7v-6h6z' fill='%23fff'/%3E%3C/svg%3E"
        />
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin="" />
        <link
          rel="stylesheet"
          href="https://fonts.googleapis.com/css2?family=Archivo:wdth,wght@62..125,400..900&family=IBM+Plex+Mono:wght@400;500;600&display=swap"
        />
        <link rel="stylesheet" href="/static/styles.css" />
        <script src="/static/htmx.min.js" defer></script>
      </head>
      <body>
        <header class="masthead">
          <div class="masthead__inner">
            <a class="brand" href="/">
              <span class="brand__mark" aria-hidden="true"></span>
              <span class="brand__name">Abholbereit</span>
              <span class="brand__sub">Apple Store pickup · CH</span>
            </a>
            <nav class="nav" aria-label="Main">
              {NAV.map((item) => (
                <a href={item.href} class="nav__link" aria-current={item.key === props.active ? "page" : undefined}>
                  {item.label}
                </a>
              ))}
            </nav>
            <HealthPill status={props.status} now={props.now} />
          </div>
        </header>
        {props.flash ? (
          <div class="flash" role="status">
            {props.flash}
          </div>
        ) : null}
        <main class="page">{props.children}</main>
        <footer class="footer">
          Private tool · In-store pickup at the 4 Swiss Apple Stores · Data from apple.com/ch-de
        </footer>
      </body>
    </html>
  );
}

/** Renders a full page inside the layout. */
export function renderPage(
  c: Context,
  deps: WebDeps,
  page: { title: string; active: NavKey; body: Child; status?: number },
) {
  const html = (
    <Layout
      title={page.title}
      active={page.active}
      flash={c.req.query("flash")}
      status={deps.checker.status()}
      now={deps.clock.now()}
    >
      {page.body}
    </Layout>
  );
  return c.html(`<!doctype html>${html}`, (page.status ?? 200) as 200);
}

export function redirectWithFlash(c: Context, path: string, message: string) {
  return c.redirect(`${path}?flash=${encodeURIComponent(message)}`, 303);
}
