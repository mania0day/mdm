import { db } from '../db.js';

const insertAlert = db.prepare(`
  INSERT INTO alerts (device_id, severity, type, message)
  VALUES (@device_id, @severity, @type, @message)
`);

/**
 * Raise a monitoring alert (Proposal 6.4 Device Monitoring & Alerts).
 * Deduplicates identical unacknowledged alerts of the same type for a device
 * so a repeatedly non-compliant device does not flood the alert feed.
 */
const recentDupe = db.prepare(`
  SELECT id FROM alerts
  WHERE device_id IS @device_id AND type = @type AND acknowledged = 0
    AND created_at > datetime('now', '-10 minutes')
  LIMIT 1
`);

export function raiseAlert({ deviceId = null, severity = 'info', type, message }) {
  const dupe = recentDupe.get({ device_id: deviceId, type });
  if (dupe) return dupe.id;
  const info = insertAlert.run({
    device_id: deviceId,
    severity,
    type,
    message,
  });
  return info.lastInsertRowid;
}
