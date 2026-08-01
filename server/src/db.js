import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import { config } from './config.js';

// Ensure the data directory exists before opening the database file.
fs.mkdirSync(path.dirname(config.dbPath), { recursive: true });

export const db = new Database(config.dbPath);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

// NOTE: the schema is created here, at module load, so that every route/service
// module can safely prepare statements against these tables at *their* import
// time (ES module imports execute before index.js calls seed()).
initSchema();

/**
 * Create the full SENTROID schema if it does not already exist.
 * The schema maps directly to the proposal's functional components:
 *  - users            -> Administrative Control & role-based access
 *  - enrollment_tokens-> Device Enrollment & Registration
 *  - devices          -> managed device inventory + status monitoring
 *  - policies         -> Policy Enforcement definitions
 *  - device_policies  -> policy assignment
 *  - commands         -> Remote command execution queue
 *  - alerts           -> Device Monitoring & Alerts
 *  - audit_logs       -> Administrative logging / accountability
 */
export function initSchema() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      username      TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      full_name     TEXT NOT NULL,
      role          TEXT NOT NULL DEFAULT 'operator',
      active        INTEGER NOT NULL DEFAULT 1,
      last_login    TEXT,
      created_at    TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS enrollment_tokens (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      token       TEXT UNIQUE NOT NULL,
      label       TEXT,
      department  TEXT,
      created_by  INTEGER REFERENCES users(id),
      used        INTEGER NOT NULL DEFAULT 0,
      device_id   INTEGER REFERENCES devices(id) ON DELETE SET NULL,
      expires_at  TEXT,
      created_at  TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS devices (
      id                INTEGER PRIMARY KEY AUTOINCREMENT,
      device_uid        TEXT UNIQUE NOT NULL,
      device_token      TEXT UNIQUE NOT NULL,
      name              TEXT,
      owner_name        TEXT,
      department        TEXT,
      manufacturer      TEXT,
      model             TEXT,
      os_version        TEXT,
      sdk_int           INTEGER,
      serial            TEXT,
      status            TEXT NOT NULL DEFAULT 'active',
      admin_active      INTEGER NOT NULL DEFAULT 0,
      compliance        TEXT NOT NULL DEFAULT 'unknown',
      battery_level     INTEGER,
      battery_charging  INTEGER,
      network_type      TEXT,
      is_rooted         INTEGER DEFAULT 0,
      encryption_on     INTEGER DEFAULT 0,
      latitude          REAL,
      longitude         REAL,
      last_seen         TEXT,
      enrolled_at       TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS policies (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      name          TEXT UNIQUE NOT NULL,
      description   TEXT,
      config        TEXT NOT NULL DEFAULT '{}',
      is_default    INTEGER NOT NULL DEFAULT 0,
      created_by    INTEGER REFERENCES users(id),
      created_at    TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at    TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS device_policies (
      device_id   INTEGER NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
      policy_id   INTEGER NOT NULL REFERENCES policies(id) ON DELETE CASCADE,
      assigned_at TEXT NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY (device_id, policy_id)
    );

    CREATE TABLE IF NOT EXISTS commands (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      device_id   INTEGER NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
      type        TEXT NOT NULL,
      payload     TEXT NOT NULL DEFAULT '{}',
      status      TEXT NOT NULL DEFAULT 'pending',
      result      TEXT,
      issued_by   INTEGER REFERENCES users(id),
      issued_at   TEXT NOT NULL DEFAULT (datetime('now')),
      sent_at     TEXT,
      completed_at TEXT
    );

    CREATE TABLE IF NOT EXISTS alerts (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      device_id   INTEGER REFERENCES devices(id) ON DELETE CASCADE,
      severity    TEXT NOT NULL DEFAULT 'info',
      type        TEXT NOT NULL,
      message     TEXT NOT NULL,
      acknowledged INTEGER NOT NULL DEFAULT 0,
      acked_by    INTEGER REFERENCES users(id),
      created_at  TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS audit_logs (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      actor_type  TEXT NOT NULL DEFAULT 'user',
      actor_id    INTEGER,
      actor_label TEXT,
      action      TEXT NOT NULL,
      target_type TEXT,
      target_id   TEXT,
      details     TEXT,
      ip          TEXT,
      created_at  TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_commands_device ON commands(device_id, status);
    CREATE INDEX IF NOT EXISTS idx_alerts_device ON alerts(device_id);
    CREATE INDEX IF NOT EXISTS idx_audit_created ON audit_logs(created_at);
  `);
}
