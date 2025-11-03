// db.js (ESM)
import Database from "better-sqlite3";

export const db = new Database(process.env.SQLITE_PATH || "data.db");

// Create tables & trigger once
db.exec(`
PRAGMA journal_mode = WAL;

CREATE TABLE IF NOT EXISTS orders (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  customer_chat_id INTEGER NOT NULL,
  name TEXT,
  phone TEXT,
  address TEXT,
  lat REAL,
  lon REAL,
  items_json TEXT NOT NULL,
  payment_proof_file_id TEXT,
  delivery_link TEXT,
  status TEXT NOT NULL DEFAULT 'created', -- created|paid|complete|delivered|canceled
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TRIGGER IF NOT EXISTS orders_updated_at
AFTER UPDATE ON orders
BEGIN
  UPDATE orders SET updated_at = datetime('now') WHERE id = NEW.id;
END;

CREATE TABLE IF NOT EXISTS kv (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

INSERT OR IGNORE INTO kv(key,value) VALUES ('shop_open','1');
`);

// Small helpers
export const kvGet = (k) => {
  const row = db.prepare(`SELECT value FROM kv WHERE key = ?`).get(k);
  return row ? row.value : null;
};
export const kvSet = (k, v) => {
  db.prepare(`INSERT INTO kv(key,value) VALUES (?,?)
              ON CONFLICT(key) DO UPDATE SET value=excluded.value`).run(k, v);
};
