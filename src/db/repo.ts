import type { DatabaseSync, SQLInputValue } from "node:sqlite";
import { buyLink } from "../apple/links.js";
import { KNOWN_STORES } from "../apple/stores.js";
import type { CatalogItem, PickupStatus, StoreInfo } from "../apple/types.js";

export interface CatalogRow extends CatalogItem {
  active: boolean;
  isCustom: boolean;
  updatedAt: number;
}

export interface Alert {
  id: number;
  name: string | null;
  enabled: boolean;
  createdAt: number;
  partNumbers: string[];
  storeNumbers: string[];
}

export interface AvailabilityRow {
  partNumber: string;
  storeNumber: string;
  status: PickupStatus;
  pickupDisplay: string;
  quote: string;
  productTitle: string;
  lastCheckedAt: number;
  lastChangedAt: number;
}

export interface EventRow {
  id: number;
  partNumber: string;
  storeNumber: string;
  kind: "restock" | "soldout";
  at: number;
}

export interface HitRow {
  alertId: number;
  partNumber: string;
  storeNumber: string;
  active: boolean;
  lastNotifiedAt: number | null;
}

export interface NotificationLog {
  at: number;
  kind: "restock" | "health" | "test";
  alertId: number | null;
  title: string;
  ok: boolean;
  error: string | null;
}

type Row = Record<string, SQLInputValue>;

const CUSTOM_SORT_ORDER = 9999;
const NEW_STORE_SORT_ORDER = 100;

function toCatalogRow(r: Row): CatalogRow {
  return {
    partNumber: r.part_number as string,
    family: r.family as string,
    modelName: r.model_name as string,
    title: r.title as string,
    colorKey: r.color_key as string,
    colorLabel: r.color_label as string,
    capacityKey: r.capacity_key as string,
    capacityLabel: r.capacity_label as string,
    screensizeKey: (r.screensize_key as string | null) ?? null,
    priceChf: (r.price_chf as number | null) ?? null,
    imageKey: (r.image_key as string | null) ?? null,
    productLink: r.product_link as string,
    sortOrder: r.sort_order as number,
    active: r.active === 1,
    isCustom: r.is_custom === 1,
    updatedAt: r.updated_at as number,
  };
}

function toAvailability(r: Row): AvailabilityRow {
  return {
    partNumber: r.part_number as string,
    storeNumber: r.store_number as string,
    status: r.status as PickupStatus,
    pickupDisplay: r.pickup_display as string,
    quote: r.quote as string,
    productTitle: r.product_title as string,
    lastCheckedAt: r.last_checked_at as number,
    lastChangedAt: r.last_changed_at as number,
  };
}

function toHit(r: Row): HitRow {
  return {
    alertId: r.alert_id as number,
    partNumber: r.part_number as string,
    storeNumber: r.store_number as string,
    active: r.active === 1,
    lastNotifiedAt: (r.last_notified_at as number | null) ?? null,
  };
}

export class Repo {
  constructor(private readonly db: DatabaseSync) {
    const seed = db.prepare("INSERT OR IGNORE INTO stores (store_number, name, city, sort_order) VALUES (?, ?, ?, ?)");
    KNOWN_STORES.forEach((s, i) => seed.run(s.storeNumber, s.name, s.city, i));
  }

  private transaction(fn: () => void): void {
    this.db.exec("BEGIN");
    try {
      fn();
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  // --- settings ---

  getSetting(key: string): string | undefined {
    const row = this.db.prepare("SELECT value FROM settings WHERE key = ?").get(key) as Row | undefined;
    return row?.value as string | undefined;
  }

  setSetting(key: string, value: string): void {
    this.db
      .prepare("INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value")
      .run(key, value);
  }

  // --- catalog ---

  upsertCatalogItems(items: CatalogItem[], now: number): void {
    const stmt = this.db.prepare(`
      INSERT INTO catalog_items (part_number, family, model_name, title, color_key, color_label, capacity_key,
        capacity_label, screensize_key, price_chf, image_key, product_link, sort_order, active, is_custom, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, 0, ?)
      ON CONFLICT (part_number) DO UPDATE SET
        family = excluded.family, model_name = excluded.model_name, title = excluded.title,
        color_key = excluded.color_key, color_label = excluded.color_label, capacity_key = excluded.capacity_key,
        capacity_label = excluded.capacity_label, screensize_key = excluded.screensize_key,
        price_chf = excluded.price_chf, image_key = excluded.image_key, product_link = excluded.product_link,
        sort_order = excluded.sort_order, active = 1, is_custom = 0, updated_at = excluded.updated_at`);
    this.transaction(() => {
      for (const i of items) {
        stmt.run(i.partNumber, i.family, i.modelName, i.title, i.colorKey, i.colorLabel, i.capacityKey,
          i.capacityLabel, i.screensizeKey, i.priceChf, i.imageKey, i.productLink, i.sortOrder, now);
      }
    });
  }

  /** Marks items of `family` that are not in `keep` inactive. Returns how many changed. */
  deactivateMissing(family: string, keep: string[], now: number): number {
    const placeholders = keep.map(() => "?").join(", ") || "NULL";
    const result = this.db
      .prepare(`UPDATE catalog_items SET active = 0, updated_at = ?
                WHERE family = ? AND active = 1 AND is_custom = 0 AND part_number NOT IN (${placeholders})`)
      .run(now, family, ...keep);
    return Number(result.changes);
  }

  addCustomPart(partNumber: string, title: string, now: number): void {
    this.db
      .prepare(`
        INSERT INTO catalog_items (part_number, family, model_name, title, color_key, color_label, capacity_key,
          capacity_label, screensize_key, price_chf, image_key, product_link, sort_order, active, is_custom, updated_at)
        VALUES (?, 'custom', 'Custom', ?, '', '', '', '', NULL, NULL, NULL, ?, ?, 1, 1, ?)
        ON CONFLICT (part_number) DO UPDATE SET active = 1, updated_at = excluded.updated_at`)
      .run(partNumber, title, buyLink(partNumber), CUSTOM_SORT_ORDER, now);
  }

  getCatalogItem(partNumber: string): CatalogRow | undefined {
    const row = this.db.prepare("SELECT * FROM catalog_items WHERE part_number = ?").get(partNumber) as Row | undefined;
    return row && toCatalogRow(row);
  }

  listCatalog(opts: { activeOnly?: boolean } = {}): CatalogRow[] {
    const where = opts.activeOnly ? "WHERE active = 1" : "";
    return (this.db.prepare(`SELECT * FROM catalog_items ${where} ORDER BY sort_order, model_name, title`).all() as Row[]).map(
      toCatalogRow,
    );
  }

  // --- stores ---

  upsertStores(stores: StoreInfo[]): void {
    const stmt = this.db.prepare(`
      INSERT INTO stores (store_number, name, city, sort_order) VALUES (?, ?, ?, ?)
      ON CONFLICT (store_number) DO UPDATE SET name = excluded.name, city = excluded.city`);
    for (const s of stores) stmt.run(s.storeNumber, s.name, s.city, NEW_STORE_SORT_ORDER);
  }

  listStores(): StoreInfo[] {
    return (this.db.prepare("SELECT * FROM stores ORDER BY sort_order, store_number").all() as Row[]).map((r) => ({
      storeNumber: r.store_number as string,
      name: r.name as string,
      city: r.city as string,
    }));
  }

  // --- alerts ---

  createAlert(input: { name: string | null; partNumbers: string[]; storeNumbers: string[] }, now: number): number {
    const parts = [...new Set(input.partNumbers)];
    const stores = [...new Set(input.storeNumbers)];
    if (parts.length === 0) throw new Error("An alert needs at least one part");
    if (stores.length === 0) throw new Error("An alert needs at least one store");
    let id = 0;
    this.transaction(() => {
      const result = this.db.prepare("INSERT INTO alerts (name, enabled, created_at) VALUES (?, 1, ?)").run(input.name, now);
      id = Number(result.lastInsertRowid);
      const addPart = this.db.prepare("INSERT INTO alert_parts (alert_id, position, part_number) VALUES (?, ?, ?)");
      parts.forEach((p, i) => addPart.run(id, i, p));
      const addStore = this.db.prepare("INSERT INTO alert_stores (alert_id, position, store_number) VALUES (?, ?, ?)");
      stores.forEach((s, i) => addStore.run(id, i, s));
    });
    return id;
  }

  private hydrateAlert(r: Row): Alert {
    const id = r.id as number;
    const parts = this.db.prepare("SELECT part_number FROM alert_parts WHERE alert_id = ? ORDER BY position").all(id) as Row[];
    const stores = this.db.prepare("SELECT store_number FROM alert_stores WHERE alert_id = ? ORDER BY position").all(id) as Row[];
    return {
      id,
      name: (r.name as string | null) ?? null,
      enabled: r.enabled === 1,
      createdAt: r.created_at as number,
      partNumbers: parts.map((p) => p.part_number as string),
      storeNumbers: stores.map((s) => s.store_number as string),
    };
  }

  getAlert(id: number): Alert | undefined {
    const row = this.db.prepare("SELECT * FROM alerts WHERE id = ?").get(id) as Row | undefined;
    return row && this.hydrateAlert(row);
  }

  listAlerts(): Alert[] {
    return (this.db.prepare("SELECT * FROM alerts ORDER BY created_at DESC, id DESC").all() as Row[]).map((r) =>
      this.hydrateAlert(r),
    );
  }

  /** Enabling an alert starts it fresh: it will push for stock that is already there. */
  setAlertEnabled(id: number, enabled: boolean): void {
    this.transaction(() => {
      this.db.prepare("UPDATE alerts SET enabled = ? WHERE id = ?").run(enabled ? 1 : 0, id);
      if (enabled) this.db.prepare("DELETE FROM alert_hits WHERE alert_id = ?").run(id);
    });
  }

  deleteAlert(id: number): void {
    this.db.prepare("DELETE FROM alerts WHERE id = ?").run(id);
  }

  watchedParts(): string[] {
    const rows = this.db
      .prepare(`SELECT DISTINCT p.part_number FROM alert_parts p JOIN alerts a ON a.id = p.alert_id
                WHERE a.enabled = 1 ORDER BY p.part_number`)
      .all() as Row[];
    return rows.map((r) => r.part_number as string);
  }

  // --- availability ---

  getAvailability(partNumber: string, storeNumber: string): AvailabilityRow | undefined {
    const row = this.db
      .prepare("SELECT * FROM availability WHERE part_number = ? AND store_number = ?")
      .get(partNumber, storeNumber) as Row | undefined;
    return row && toAvailability(row);
  }

  listAvailability(): AvailabilityRow[] {
    return (this.db.prepare("SELECT * FROM availability").all() as Row[]).map(toAvailability);
  }

  upsertAvailability(a: AvailabilityRow): void {
    this.db
      .prepare(`
        INSERT INTO availability (part_number, store_number, status, pickup_display, quote, product_title,
          last_checked_at, last_changed_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT (part_number, store_number) DO UPDATE SET
          status = excluded.status, pickup_display = excluded.pickup_display, quote = excluded.quote,
          product_title = excluded.product_title, last_checked_at = excluded.last_checked_at,
          last_changed_at = excluded.last_changed_at`)
      .run(a.partNumber, a.storeNumber, a.status, a.pickupDisplay, a.quote, a.productTitle, a.lastCheckedAt, a.lastChangedAt);
  }

  // --- events ---

  insertEvent(e: Omit<EventRow, "id">): void {
    this.db
      .prepare("INSERT INTO events (part_number, store_number, kind, at) VALUES (?, ?, ?, ?)")
      .run(e.partNumber, e.storeNumber, e.kind, e.at);
  }

  listEvents(limit: number): EventRow[] {
    return (this.db.prepare("SELECT * FROM events ORDER BY at DESC, id DESC LIMIT ?").all(limit) as Row[]).map((r) => ({
      id: r.id as number,
      partNumber: r.part_number as string,
      storeNumber: r.store_number as string,
      kind: r.kind as EventRow["kind"],
      at: r.at as number,
    }));
  }

  // --- alert hits ---

  getHit(alertId: number, partNumber: string, storeNumber: string): HitRow | undefined {
    const row = this.db
      .prepare("SELECT * FROM alert_hits WHERE alert_id = ? AND part_number = ? AND store_number = ?")
      .get(alertId, partNumber, storeNumber) as Row | undefined;
    return row && toHit(row);
  }

  upsertHit(h: HitRow): void {
    this.db
      .prepare(`
        INSERT INTO alert_hits (alert_id, part_number, store_number, active, last_notified_at) VALUES (?, ?, ?, ?, ?)
        ON CONFLICT (alert_id, part_number, store_number) DO UPDATE SET
          active = excluded.active, last_notified_at = excluded.last_notified_at`)
      .run(h.alertId, h.partNumber, h.storeNumber, h.active ? 1 : 0, h.lastNotifiedAt);
  }

  listHits(alertId: number): HitRow[] {
    return (this.db.prepare("SELECT * FROM alert_hits WHERE alert_id = ?").all(alertId) as Row[]).map(toHit);
  }

  // --- notification log ---

  logNotification(n: NotificationLog): void {
    this.db
      .prepare("INSERT INTO notifications (at, kind, alert_id, title, ok, error) VALUES (?, ?, ?, ?, ?, ?)")
      .run(n.at, n.kind, n.alertId, n.title, n.ok ? 1 : 0, n.error);
  }

  listNotifications(limit: number): (NotificationLog & { id: number })[] {
    return (this.db.prepare("SELECT * FROM notifications ORDER BY at DESC, id DESC LIMIT ?").all(limit) as Row[]).map((r) => ({
      id: r.id as number,
      at: r.at as number,
      kind: r.kind as NotificationLog["kind"],
      alertId: (r.alert_id as number | null) ?? null,
      title: r.title as string,
      ok: r.ok === 1,
      error: (r.error as string | null) ?? null,
    }));
  }
}
