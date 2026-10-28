import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS catalog_items (
  part_number TEXT PRIMARY KEY,
  family TEXT NOT NULL,
  model_name TEXT NOT NULL,
  title TEXT NOT NULL,
  color_key TEXT NOT NULL,
  color_label TEXT NOT NULL,
  capacity_key TEXT NOT NULL,
  capacity_label TEXT NOT NULL,
  screensize_key TEXT,
  price_chf REAL,
  image_key TEXT,
  product_link TEXT NOT NULL,
  sort_order INTEGER NOT NULL,
  active INTEGER NOT NULL DEFAULT 1,
  is_custom INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS stores (
  store_number TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  city TEXT NOT NULL,
  sort_order INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS alerts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT,
  enabled INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS alert_parts (
  alert_id INTEGER NOT NULL REFERENCES alerts(id) ON DELETE CASCADE,
  position INTEGER NOT NULL,
  part_number TEXT NOT NULL,
  PRIMARY KEY (alert_id, part_number)
);

CREATE TABLE IF NOT EXISTS alert_stores (
  alert_id INTEGER NOT NULL REFERENCES alerts(id) ON DELETE CASCADE,
  position INTEGER NOT NULL,
  store_number TEXT NOT NULL,
  PRIMARY KEY (alert_id, store_number)
);

CREATE TABLE IF NOT EXISTS alert_hits (
  alert_id INTEGER NOT NULL REFERENCES alerts(id) ON DELETE CASCADE,
  part_number TEXT NOT NULL,
  store_number TEXT NOT NULL,
  active INTEGER NOT NULL,
  last_notified_at INTEGER,
  PRIMARY KEY (alert_id, part_number, store_number)
);

CREATE TABLE IF NOT EXISTS availability (
  part_number TEXT NOT NULL,
  store_number TEXT NOT NULL,
  status TEXT NOT NULL,
  pickup_display TEXT NOT NULL,
  quote TEXT NOT NULL,
  product_title TEXT NOT NULL,
  last_checked_at INTEGER NOT NULL,
  last_changed_at INTEGER NOT NULL,
  PRIMARY KEY (part_number, store_number)
);

CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  part_number TEXT NOT NULL,
  store_number TEXT NOT NULL,
  kind TEXT NOT NULL,
  at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS events_at ON events (at);

CREATE TABLE IF NOT EXISTS notifications (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  at INTEGER NOT NULL,
  kind TEXT NOT NULL,
  alert_id INTEGER,
  title TEXT NOT NULL,
  ok INTEGER NOT NULL,
  error TEXT
);
`;

export function openDb(file: string): DatabaseSync {
  if (file !== ":memory:") mkdirSync(dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  if (file !== ":memory:") db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA foreign_keys = ON");
  db.exec(SCHEMA);
  return db;
}
