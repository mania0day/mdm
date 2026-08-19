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

    -- Policy violations reported by the agent.
    --
    -- The other half of the enforce/monitor design: a rule in 'monitor' mode is
    -- deliberately NOT blocked on the device, so the only trace it ever leaves
    -- is the record written here. (A rule in 'enforce' mode can also land here
    -- when the handset is too old to enforce it — an Android 10 phone cannot
    -- block a non-approved Wi-Fi SSID, but it can still report joining one.)
    --
    -- Kept separate from the alerts table: an alert is an operator notification that
    -- gets acknowledged and cleared, whereas a violation is durable evidence of
    -- what a specific device did — "who used the camera / made calls / joined an
    -- unapproved network" — and is what the device's Violations tab reads.
    -- Both are written for a breach: this row is the record, the alert is the
    -- notification.
    CREATE TABLE IF NOT EXISTS policy_violations (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      device_id   INTEGER NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
      rule        TEXT NOT NULL,          -- e.g. 'block_outgoing_calls'
      mode        TEXT NOT NULL,          -- mode in force when it happened
      severity    TEXT NOT NULL DEFAULT 'warning',
      detail      TEXT,                   -- human-readable specifics
      metadata    TEXT,                   -- JSON: ssid, package name, number, ...
      occurred_at TEXT,                   -- device clock, when it actually happened
      created_at  TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_commands_device ON commands(device_id, status);
    CREATE INDEX IF NOT EXISTS idx_alerts_device ON alerts(device_id);
    CREATE INDEX IF NOT EXISTS idx_audit_created ON audit_logs(created_at);
    CREATE INDEX IF NOT EXISTS idx_violations_device
      ON policy_violations(device_id, created_at DESC);
  `);

  migrateDeviceScanColumns();
}

// devices table columns added after the initial release for the fleet
// inventory scan. CREATE TABLE IF NOT EXISTS above does not retrofit an
// existing database file, so add any missing columns here (idempotent —
// checks pragma table_info before each ALTER TABLE).
function migrateDeviceScanColumns() {
  const existing = new Set(db.prepare('PRAGMA table_info(devices)').all().map((c) => c.name));
  const newColumns = {
    imei: 'TEXT',
    phone_number: 'TEXT',
    sim_operator: 'TEXT',
    build_fingerprint: 'TEXT',
    security_patch: 'TEXT',
    management_mode: "TEXT NOT NULL DEFAULT 'none'",
    // Admin-entered identifier (employee ID or contact number), set when the
    // enrollment token is issued and carried onto the device at enroll time.
    employee_id: 'TEXT',
    // Server-gated permission for the on-device "IT setup / re-configure"
    // technical view — off by default so a normal user never sees device
    // internals; an admin flips this on remotely only when a technician
    // actually needs to touch the device's setup screen.
    allow_reconfigure: 'INTEGER NOT NULL DEFAULT 0',
    // Best score from the on-device dino-runner mini-game.
    high_score: 'INTEGER NOT NULL DEFAULT 0',
    // Timestamp the device was flagged as having gone silent (no check-in past
    // the offline-alert threshold). NULL while the device is reporting; set
    // once by the offline monitor when it transitions to offline, and cleared
    // on the next check-in. Drives one-shot "went offline"/"back online"
    // logging instead of re-alerting on every sweep.
    offline_since: 'TEXT',
  };
  for (const [name, ddl] of Object.entries(newColumns)) {
    if (!existing.has(name)) {
      db.exec(`ALTER TABLE devices ADD COLUMN ${name} ${ddl}`);
    }
  }

  const existingTokenCols = new Set(
    db.prepare('PRAGMA table_info(enrollment_tokens)').all().map((c) => c.name),
  );
  if (!existingTokenCols.has('employee_id')) {
    db.exec('ALTER TABLE enrollment_tokens ADD COLUMN employee_id TEXT');
  }
}
