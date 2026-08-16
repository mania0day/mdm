import { Router } from 'express';
import { db } from '../db.js';
import { config } from '../config.js';
import { requireAuth } from '../middleware/auth.js';
import { getCveExposure } from '../services/cveService.js';

export const statsRouter = Router();
statsRouter.use(requireAuth);

// GET /api/stats -> dashboard summary cards + recent activity
statsRouter.get('/', (req, res) => {
  const totalDevices = db.prepare('SELECT COUNT(*) c FROM devices').get().c;
  const byStatus = db
    .prepare('SELECT status, COUNT(*) c FROM devices GROUP BY status')
    .all()
    .reduce((acc, r) => ((acc[r.status] = r.c), acc), {});
  const byCompliance = db
    .prepare('SELECT compliance, COUNT(*) c FROM devices GROUP BY compliance')
    .all()
    .reduce((acc, r) => ((acc[r.compliance] = r.c), acc), {});

  // Manufacturer breakdown — only real, present values (never a hardcoded
  // vendor list padded with zeros for makes nobody actually enrolled).
  const byManufacturer = db
    .prepare(
      `SELECT COALESCE(NULLIF(TRIM(manufacturer), ''), 'Unknown') AS make, COUNT(*) c
       FROM devices GROUP BY make ORDER BY c DESC`,
    )
    .all()
    .reduce((acc, r) => ((acc[r.make] = r.c), acc), {});

  const byRooted = db
    .prepare('SELECT is_rooted, COUNT(*) c FROM devices GROUP BY is_rooted')
    .all()
    .reduce((acc, r) => ((acc[r.is_rooted ? 'rooted' : 'not_rooted'] = r.c), acc), {});

  // CVE risk tier across the whole fleet — each device's exposure computed
  // the same way as its individual Analysis Report, tallied AND listed per
  // device so the chart can show exactly which devices carry the risk,
  // not just an aggregate count.
  const allDevices = db
    .prepare('SELECT id, name, manufacturer, model, is_rooted, os_version, security_patch FROM devices')
    .all();
  const cveByLevel = { NONE: 0, LOW: 0, MEDIUM: 0, HIGH: 0, CRITICAL: 0, UNKNOWN: 0 };
  // Real CVE volume across the fleet — a device-count-per-tier bucket chart
  // is meaningless on a small fleet (one device = one trivial bar); the
  // actual number of unpatched CVEs by severity is the number that matters
  // and scales sensibly as the fleet grows.
  const cveVolume = { critical: 0, high: 0, medium: 0 };
  let devicesEol = 0;
  const deviceRisk = [];
  for (const d of allDevices) {
    const exposure = getCveExposure(d.os_version, d.security_patch);
    const level = exposure ? exposure.overall_level : 'UNKNOWN';
    cveByLevel[level] = (cveByLevel[level] || 0) + 1;
    if (exposure) {
      cveVolume.critical += exposure.critical_count;
      cveVolume.high += exposure.high_count;
      cveVolume.medium += exposure.medium_count;
    }
    if (exposure?.os_eol) devicesEol += 1;
    deviceRisk.push({
      id: d.id,
      name: d.name,
      manufacturer: d.manufacturer,
      model: d.model,
      is_rooted: !!d.is_rooted,
      cve_level: level,
      unpatched: exposure?.total_unpatched ?? null,
    });
  }
  const rootOrder = { CRITICAL: 0, HIGH: 1, MEDIUM: 2, LOW: 3, UNKNOWN: 4, NONE: 5 };
  deviceRisk.sort((a, b) => (rootOrder[a.cve_level] ?? 9) - (rootOrder[b.cve_level] ?? 9));

  const thresholdSec = config.deviceOfflineThresholdSeconds;
  const online = db
    .prepare(
      `SELECT COUNT(*) c FROM devices WHERE last_seen IS NOT NULL
       AND (julianday('now') - julianday(last_seen)) * 86400 < ?`,
    )
    .get(thresholdSec).c;

  const pendingCommands = db
    .prepare("SELECT COUNT(*) c FROM commands WHERE status IN ('pending','sent')")
    .get().c;
  const unackAlerts = db.prepare('SELECT COUNT(*) c FROM alerts WHERE acknowledged = 0').get().c;
  const criticalAlerts = db
    .prepare("SELECT COUNT(*) c FROM alerts WHERE acknowledged = 0 AND severity = 'critical'")
    .get().c;

  const recentCommands = db
    .prepare(
      `SELECT c.id, c.type, c.status, c.issued_at, d.name AS device_name, u.username AS issued_by_name
       FROM commands c LEFT JOIN devices d ON d.id = c.device_id
       LEFT JOIN users u ON u.id = c.issued_by
       ORDER BY c.issued_at DESC LIMIT 8`,
    )
    .all();

  const enrollTrend = db
    .prepare(
      `SELECT date(enrolled_at) d, COUNT(*) c FROM devices
       GROUP BY date(enrolled_at) ORDER BY d DESC LIMIT 14`,
    )
    .all()
    .reverse();

  res.json({
    devices: {
      total: totalDevices,
      online,
      offline: totalDevices - online,
      byStatus,
      byCompliance,
      byManufacturer,
      byRooted,
    },
    cve: { byLevel: cveByLevel, volume: cveVolume, devicesEol, devices: deviceRisk },
    pendingCommands,
    alerts: { unacknowledged: unackAlerts, critical: criticalAlerts },
    recentCommands,
    enrollTrend,
  });
});
