import { db } from '../db.js';
import { config } from '../config.js';
import { audit } from '../utils/audit.js';
import { raiseAlert } from './alertService.js';

// Devices in these terminal lifecycle states are intentionally gone and must
// not be re-flagged as "offline" — they already left management.
const IGNORED_STATUSES = "('unenrolled', 'wiped')";

// Currently-stale, not-yet-flagged devices whose silence should be reported.
const findNewlyOffline = db.prepare(`
  SELECT id, name, last_seen FROM devices
  WHERE last_seen IS NOT NULL
    AND offline_since IS NULL
    AND status NOT IN ${IGNORED_STATUSES}
    AND (julianday('now') - julianday(last_seen)) * 86400 >= @threshold
`);
const markOffline = db.prepare("UPDATE devices SET offline_since = datetime('now') WHERE id = ?");

/**
 * Silent one-time baseline run at startup: any device already stale when the
 * server boots is marked offline WITHOUT logging or alerting. We can't know
 * when it actually went dark (could be days ago), so retroactively alerting on
 * it would be noise. After this, only genuine online→offline transitions that
 * happen while the server is running produce a log + alert.
 */
function baselineOffline() {
  const stale = findNewlyOffline.all({ threshold: config.deviceOfflineAlertSeconds });
  for (const d of stale) markOffline.run(d.id);
  return stale.length;
}

/**
 * One sweep: find devices that have crossed the offline threshold since the
 * last sweep and, for each, record an audit entry + raise a warning alert.
 * Marking offline_since is what keeps this to a single event per outage — the
 * device drops out of findNewlyOffline until it checks in again (which clears
 * offline_since, see agent check-in).
 */
export function sweepOffline() {
  const threshold = config.deviceOfflineAlertSeconds;
  const nowOffline = findNewlyOffline.all({ threshold });
  for (const d of nowOffline) {
    markOffline.run(d.id);
    audit({
      actorType: 'system',
      actorLabel: 'offline-monitor',
      action: 'DEVICE_OFFLINE',
      targetType: 'device',
      targetId: d.id,
      details: { last_seen: d.last_seen, threshold_seconds: threshold },
    });
    const mins = Math.round(threshold / 60);
    raiseAlert({
      deviceId: d.id,
      severity: 'warning',
      type: 'DEVICE_OFFLINE',
      message:
        `"${d.name}" went offline — no check-in for over ${mins} min ` +
        `(powered off, lost connectivity, or the SENTROID agent was removed/uninstalled)`,
    });
  }
  return nowOffline.length;
}

/**
 * Start the periodic offline sweep. The interval is unref()'d so it never keeps
 * the process alive on its own, and the whole monitor is skipped under tests.
 * Returns the interval handle (or null when not started) for clean shutdown.
 */
export function startOfflineMonitor() {
  if (config.env === 'test') return null;
  baselineOffline();
  const handle = setInterval(sweepOffline, config.deviceOfflineSweepSeconds * 1000);
  if (typeof handle.unref === 'function') handle.unref();
  return handle;
}
