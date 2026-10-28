import type { Context, Hono } from "hono";
import type { CatalogRow } from "../../db/repo.js";
import type { WebDeps } from "../deps.js";
import { redirectWithFlash, renderPage } from "../layout.js";
import { capacityGb } from "../status.js";

const LOOKUP_MESSAGES = {
  invalid: { status: 400, text: "That doesn't look like an Apple part number (e.g. MK2D4QL/A)" },
  unknown: { status: 400, text: "Apple doesn't know this part for Switzerland" },
  backoff: { status: 503, text: "Apple is rate-limiting us right now — try again in a few minutes" },
} as const;

function formList(value: string | File | (string | File)[] | undefined): string[] {
  if (value === undefined) return [];
  return (Array.isArray(value) ? value : [value]).filter((v): v is string => typeof v === "string" && v.trim() !== "").map((v) => v.trim());
}

function formText(value: string | File | (string | File)[] | undefined): string {
  const first = Array.isArray(value) ? value[0] : value;
  return typeof first === "string" ? first.trim() : "";
}

export function registerNewAlert(app: Hono, deps: WebDeps): void {
  const { repo, clock, config } = deps;

  const models = () => {
    const byModel = new Map<string, CatalogRow[]>();
    for (const item of repo.listCatalog({ activeOnly: true })) {
      if (item.isCustom) continue;
      byModel.set(item.modelName, [...(byModel.get(item.modelName) ?? []), item]);
    }
    return byModel;
  };

  function StoreChecks(props: { selected?: string[] }) {
    const selected = props.selected;
    return (
      <fieldset class="fieldset">
        <legend>Stores</legend>
        <div class="checks">
          {repo.listStores().map((s) => (
            <label class="check">
              <input type="checkbox" name="store" value={s.storeNumber} checked={!selected || selected.includes(s.storeNumber)} />
              {s.name} <span class="eyebrow">{s.city}</span>
            </label>
          ))}
        </div>
      </fieldset>
    );
  }

  function NameField(props: { value?: string }) {
    return (
      <div class="field">
        <label for="name">Name (optional)</label>
        <input class="input" id="name" name="name" value={props.value ?? ""} placeholder="e.g. Duo for me" autocomplete="off" />
      </div>
    );
  }

  function render(c: Context, opts: { model?: string; error?: string; status?: number; form?: Record<string, string[]> } = {}) {
    const byModel = models();
    const items = opts.model ? byModel.get(opts.model) : undefined;
    const form = opts.form ?? {};

    let body;
    if (byModel.size === 0 && !opts.model) {
      body = <p class="empty">Catalog is still loading — refresh in a minute.</p>;
    }

    const modelList = (
      <ul class="models">
        {[...byModel.entries()].map(([name, list]) => (
          <li>
            <a href={`/alerts/new?model=${encodeURIComponent(name)}`} aria-current={name === opts.model ? "true" : undefined}>
              {name}
              <small>{list.length} configurations</small>
            </a>
          </li>
        ))}
      </ul>
    );

    if (items) {
      const colors = [...new Set(items.map((i) => i.colorLabel))];
      const capacities = [...new Set([...items].sort((a, b) => capacityGb(a) - capacityGb(b)).map((i) => i.capacityLabel))];
      const cell = (capacity: string, color: string) => items.find((i) => i.capacityLabel === capacity && i.colorLabel === color);
      const picked = form.part ?? [];
      body = (
        <>
          {modelList}
          <section class="panel">
            <h2 class="panel__title">{opts.model}</h2>
            <form method="post" action="/alerts">
              <input type="hidden" name="model" value={opts.model} />
              <fieldset class="fieldset">
                <legend>Configurations — tick every one you'd take</legend>
                <div class="scroll-x">
                  <table class="picker">
                    <thead>
                      <tr>
                        <th></th>
                        {colors.map((color) => (
                          <th>{color}</th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {capacities.map((capacity) => (
                        <tr>
                          <th>{capacity}</th>
                          {colors.map((color) => {
                            const item = cell(capacity, color);
                            return (
                              <td>
                                {item ? (
                                  <label class="check" title={item.title}>
                                    <input type="checkbox" name="part" value={item.partNumber} checked={picked.includes(item.partNumber)} aria-label={item.title} />
                                    <span class="mono">{item.priceChf ? `CHF ${item.priceChf}` : item.partNumber}</span>
                                  </label>
                                ) : null}
                              </td>
                            );
                          })}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </fieldset>
              <StoreChecks selected={form.store} />
              <NameField value={form.name?.[0]} />
              <button class="button button--primary" type="submit">
                Create alert
              </button>
            </form>
          </section>
        </>
      );
    } else if (byModel.size > 0 || opts.model) {
      body = (
        <>
          <p class="lede">Pick a model, then tick the configurations and stores you care about.</p>
          {modelList}
        </>
      );
    }

    const custom = items ? null : (
      <section class="panel">
        <h2 class="panel__title">Any other part number</h2>
        <p class="lede">
          Paste an Apple part number (Swiss ones end in <span class="mono">QL/A</span> for iPhones, e.g.{" "}
          <span class="mono">MK2D4QL/A</span>). We ask Apple once to check it exists here.
        </p>
        <form method="post" action="/alerts/custom">
          <div class="field">
            <label for="partNumber">Part number</label>
            <input class="input mono" id="partNumber" name="partNumber" value={form.partNumber?.[0] ?? ""} required autocomplete="off" spellcheck={false} />
          </div>
          <StoreChecks selected={form.store} />
          <NameField value={form.name?.[0]} />
          <button class="button" type="submit">
            Check part and create alert
          </button>
        </form>
      </section>
    );

    return renderPage(c, deps, {
      title: "New alert",
      active: "alerts",
      status: opts.status,
      body: (
        <>
          <h1 class="title">New alert</h1>
          {opts.error ? (
            <div class="error" role="alert">
              {opts.error}
            </div>
          ) : null}
          {body}
          {custom}
        </>
      ),
    });
  }

  app.get("/alerts/new", (c) => render(c, { model: c.req.query("model") }));

  app.post("/alerts", async (c) => {
    const body = await c.req.parseBody({ all: true });
    const parts = formList(body.part);
    const stores = formList(body.store);
    const name = formText(body.name);
    const model = formText(body.model) || undefined;
    const form = { part: parts, store: stores, name: [name] };
    const fail = (error: string) => render(c, { model, error, status: 400, form });

    if (parts.length === 0) return fail("Pick at least one configuration");
    if (stores.length === 0) return fail("Pick at least one store");
    const knownStores = new Set(repo.listStores().map((s) => s.storeNumber));
    const validParts = parts.every((p) => repo.getCatalogItem(p)?.active);
    if (!validParts || !stores.every((s) => knownStores.has(s))) return fail("Unknown configuration or store");

    repo.createAlert({ name: name || null, partNumbers: parts, storeNumbers: stores }, clock.now());
    return redirectWithFlash(c, "/", "Alert created");
  });

  app.post("/alerts/custom", async (c) => {
    const body = await c.req.parseBody({ all: true });
    const partNumber = formText(body.partNumber);
    const stores = formList(body.store);
    const name = formText(body.name);
    const form = { partNumber: [partNumber], store: stores, name: [name] };
    const fail = (error: string, status = 400) => render(c, { error, status, form });

    if (stores.length === 0) return fail("Pick at least one store");
    const knownStores = new Set(repo.listStores().map((s) => s.storeNumber));
    if (!stores.every((s) => knownStores.has(s))) return fail("Unknown configuration or store");

    const result = await deps.catalog.lookupCustomPart(partNumber, config.appleLocation);
    if (result.kind === "added") {
      repo.createAlert({ name: name || null, partNumbers: [result.partNumber], storeNumbers: stores }, clock.now());
      return redirectWithFlash(c, "/", `Alert created for ${result.title}`);
    }
    if (result.kind === "error") return fail(`Apple lookup failed: ${result.message}`, 502);
    const message = LOOKUP_MESSAGES[result.kind];
    return fail(message.text, message.status);
  });
}
