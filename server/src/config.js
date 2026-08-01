import 'dotenv/config';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export const config = {
  port: parseInt(process.env.PORT || '4000', 10),
  host: process.env.HOST || '0.0.0.0',
  env: process.env.NODE_ENV || 'development',
  jwtSecret: process.env.JWT_SECRET || 'sentroid-dev-secret-change-me',
  jwtExpiresIn: process.env.JWT_EXPIRES_IN || '12h',
  dbPath: process.env.DB_PATH || path.join(__dirname, '..', 'data', 'sentroid.db'),
  seedAdmin: {
    username: process.env.SEED_ADMIN_USERNAME || 'admin',
    password: process.env.SEED_ADMIN_PASSWORD || 'Admin@123',
    name: process.env.SEED_ADMIN_NAME || 'System Administrator',
  },
  deviceOfflineThresholdSeconds: parseInt(
    process.env.DEVICE_OFFLINE_THRESHOLD_SECONDS || '60',
    10,
  ),
};

// Role hierarchy for RBAC. Higher number = more privilege.
export const ROLES = {
  auditor: 1, // read-only: devices, logs, reports
  operator: 2, // + issue non-destructive commands (lock, locate, ping)
  admin: 3, // + destructive commands (wipe), policies, enrollment
  super_admin: 4, // + user management
};

// Command types the platform understands.
export const COMMAND_TYPES = {
  LOCK: { destructive: false, minRole: 'operator', label: 'Lock Device' },
  UNLOCK: { destructive: false, minRole: 'operator', label: 'Unlock (clear password)' },
  PING: { destructive: false, minRole: 'operator', label: 'Ping / Request Check-in' },
  LOCATE: { destructive: false, minRole: 'operator', label: 'Locate Device' },
  RING: { destructive: false, minRole: 'operator', label: 'Ring Device' },
  RESET_PASSWORD: { destructive: false, minRole: 'admin', label: 'Reset Lock Password' },
  ENFORCE_POLICY: { destructive: false, minRole: 'admin', label: 'Enforce Policy' },
  DISABLE: { destructive: true, minRole: 'admin', label: 'Disable Device' },
  ENABLE: { destructive: false, minRole: 'admin', label: 'Re-enable Device' },
  WIPE: { destructive: true, minRole: 'admin', label: 'Factory Reset / Wipe' },
};

// Policy severities for alerts.
export const ALERT_SEVERITY = ['info', 'warning', 'critical'];
