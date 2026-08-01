import { Router } from 'express';
import { db } from '../db.js';
import { config } from '../config.js';
import { requireAuth } from '../middleware/auth.js';

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
    },
    pendingCommands,
    alerts: { unacknowledged: unackAlerts, critical: criticalAlerts },
    recentCommands,
    enrollTrend,
  });
});
