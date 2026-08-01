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
const getStmt = db.prepare('SELECT * FROM alerts WHERE id = ?');

alertsRouter.get('/', (req, res) => {
  const alerts = listStmt.all();
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

alertsRouter.post(
  '/ack-all',
  asyncHandler(async (req, res) => {
    db.prepare('UPDATE alerts SET acknowledged = 1, acked_by = ? WHERE acknowledged = 0').run(
      req.user.id,
    );
    res.json({ ok: true });
  }),
);
