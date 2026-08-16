import { Router } from 'express';
import { db } from '../db.js';
import { asyncHandler, httpError } from '../middleware/error.js';
import { requireAuth } from '../middleware/auth.js';
import { audit } from '../utils/audit.js';

export const alertsRouter = Router();
alertsRouter.use(requireAuth);

const listStmt = db.prepare(`
  SELECT a.*, d.name AS device_name FROM alerts a
  LEFT JOIN devices d ON d.id = a.device_id
  ORDER BY a.acknowledged ASC, a.created_at DESC LIMIT 200
`);
const listStmtForDevice = db.prepare(`
  SELECT a.*, d.name AS device_name FROM alerts a
  LEFT JOIN devices d ON d.id = a.device_id
  WHERE a.device_id = ?
  ORDER BY a.acknowledged ASC, a.created_at DESC LIMIT 200
`);
const getStmt = db.prepare('SELECT * FROM alerts WHERE id = ?');

// GET /api/alerts?device_id= -> fleet-wide, or scoped to one device
alertsRouter.get('/', (req, res) => {
  const alerts = req.query.device_id ? listStmtForDevice.all(req.query.device_id) : listStmt.all();
  const unacked = alerts.filter((a) => !a.acknowledged).length;
  res.json({ alerts, unacknowledged: unacked });
});

alertsRouter.post(
  '/:id/ack',
  asyncHandler(async (req, res) => {
    const alert = getStmt.get(req.params.id);
    if (!alert) throw httpError(404, 'Alert not found');
    db.prepare('UPDATE alerts SET acknowledged = 1, acked_by = ? WHERE id = ?').run(
      req.user.id,
      alert.id,
    );
    audit({
      actorType: 'user',
      actorId: req.user.id,
      actorLabel: req.user.username,
      action: 'ACK_ALERT',
      targetType: 'alert',
      targetId: alert.id,
      ip: req.ip,
    });
    res.json({ ok: true });
  }),
);

// POST /api/alerts/ack-all              -> ack every open alert fleet-wide
// POST /api/alerts/ack-all?device_id=ID  -> ack only that device's open alerts
// (used by DeviceDetail on open, so its badge count resets to 0 as "seen")
alertsRouter.post(
  '/ack-all',
  asyncHandler(async (req, res) => {
    if (req.query.device_id) {
      db.prepare('UPDATE alerts SET acknowledged = 1, acked_by = ? WHERE acknowledged = 0 AND device_id = ?').run(
        req.user.id,
        req.query.device_id,
      );
    } else {
      db.prepare('UPDATE alerts SET acknowledged = 1, acked_by = ? WHERE acknowledged = 0').run(
        req.user.id,
      );
    }
    res.json({ ok: true });
  }),
);
