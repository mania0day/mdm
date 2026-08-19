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
  // How long a previously-seen device may stay silent before the server
  // logs+alerts that it went offline. Deliberately larger than the "online
  // dot" threshold above so a brief network blip does not raise an alert;
  // this is the signal that a device was powered off, lost connectivity, or
  // had the agent removed/uninstalled (an uninstall runs no on-device code,
  // so going silent is the only evidence the server can ever observe).
  deviceOfflineAlertSeconds: parseInt(
    process.env.DEVICE_OFFLINE_ALERT_SECONDS || '300',
    10,
  ),
  // How often the background sweep checks for devices that have gone silent.
  deviceOfflineSweepSeconds: parseInt(
    process.env.DEVICE_OFFLINE_SWEEP_SECONDS || '60',
    10,
  ),
  // QR / zero-touch Device Owner provisioning of the agent APK (Proposal 5.1).
  provisioning: {
    // The device-admin component the OS makes Device Owner during provisioning.
    // Full package/class form — accepted by every Android version.
    adminComponent:
      process.env.PROVISIONING_ADMIN_COMPONENT ||
      'com.sentroid.agent/com.sentroid.agent.admin.SentroidDeviceAdminReceiver',
    // Base64url SHA-256 of the APK's signing certificate. Android verifies the
    // downloaded APK against this during provisioning. build-apk.sh writes the
    // live value to apk/sentroid-agent.apk.checksum (read at request time); this
    // env/default is the fallback — the current debug-keystore checksum.
    apkSignatureChecksum:
      process.env.APK_SIGNATURE_CHECKSUM || 'roNGXuxVsJPAd_36jKy2NqklSHr1jMtfBdDGGNtl0VU',
  },
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
  // Radio/sensor controls. All four need Device Owner on the handset; the agent
  // reports honestly when the device is only a Device Admin.
  LOCATION_ON: { destructive: false, minRole: 'admin', label: 'Turn Location On' },
  LOCATION_OFF: { destructive: false, minRole: 'admin', label: 'Turn Location Off' },
  AIRPLANE_MODE_OFF: { destructive: false, minRole: 'admin', label: 'Disable Airplane Mode' },
  AIRPLANE_MODE_ALLOW: { destructive: false, minRole: 'admin', label: 'Allow Airplane Mode' },
  ENFORCE_POLICY: { destructive: false, minRole: 'admin', label: 'Enforce Policy' },
  DISABLE: { destructive: true, minRole: 'admin', label: 'Disable Device' },
  ENABLE: { destructive: false, minRole: 'admin', label: 'Re-enable Device' },
  // The only remote power control Android exposes: reboot. There is NO API to
  // power a device OFF (even as Device Owner), so "Restart" is as far as it goes.
  // Device Owner only; the agent reports honestly on a plain Device Admin.
  RESTART: { destructive: false, minRole: 'admin', label: 'Restart Device' },
  WIPE: { destructive: true, minRole: 'admin', label: 'Factory Reset / Wipe' },
  REMOTE_UNINSTALL: { destructive: true, minRole: 'admin', label: 'Remove App (Uninstall)' },
};

// Policy severities for alerts.
export const ALERT_SEVERITY = ['info', 'warning', 'critical'];
