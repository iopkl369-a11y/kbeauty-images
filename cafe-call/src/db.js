'use strict';
const { DatabaseSync } = require('node:sqlite');
const config = require('./config');

const db = new DatabaseSync(config.dbFile);

db.exec('PRAGMA journal_mode = WAL');
db.exec('PRAGMA foreign_keys = ON');

db.exec(`
  CREATE TABLE IF NOT EXISTS orders (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    biz_day       TEXT    NOT NULL,
    ticket        INTEGER NOT NULL,
    memo          TEXT,
    status        TEXT    NOT NULL DEFAULT 'preparing',
    phone         TEXT,
    phone_masked  TEXT,
    phone_state   TEXT    NOT NULL DEFAULT 'pending',
    notify_status TEXT,
    notify_channel TEXT,
    notify_error  TEXT,
    notify_count  INTEGER NOT NULL DEFAULT 0,
    created_at    INTEGER NOT NULL,
    ready_at      INTEGER,
    picked_at     INTEGER,
    purged_at     INTEGER
  );
`);

db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_orders_day_ticket ON orders(biz_day, ticket)');
db.exec('CREATE INDEX IF NOT EXISTS idx_orders_status ON orders(biz_day, status)');
db.exec('CREATE INDEX IF NOT EXISTS idx_orders_phone_state ON orders(phone_state, status)');

db.exec(`
  CREATE TABLE IF NOT EXISTS settings (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );
`);

module.exports = db;
