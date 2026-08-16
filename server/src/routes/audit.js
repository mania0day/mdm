import { Router } from 'express';
import { db } from '../db.js';
import { requireAuth } from '../middleware/auth.js';

export const auditRouter = Router();
auditRouter.use(requireAuth);

// GET /api/audit-logs?limit=&action=&actor_type=&device_id=
// device_id scopes the log to one device: entries targeting the device
// directly (enroll/deregister/policy assignment/unenroll) plus entries
// targeting one of its commands or alerts (command results, acks) —
// audit_logs itself has no device_id column, so those are resolved via a
// correlated sub-select against commands/alerts.
auditRouter.get('/', (req, res) => {
  const limit = Math.min(parseInt(req.query.limit || '200', 10), 1000);
  const filters = [];
  const params = [];
  if (req.query.action) {
    filters.push('action LIKE ?');
    params.push(`%${req.query.action}%`);
  }
  if (req.query.actor_type) {
    filters.push('actor_type = ?');
    params.push(req.query.actor_type);
  }
  if (req.query.actor_id) {
    filters.push('actor_id = ?');
    params.push(req.query.actor_id);
  }
  if (req.query.device_id) {
    const deviceId = String(req.query.device_id);
    filters.push(`(
      (target_type = 'device' AND target_id = ?)
      OR (target_type = 'command' AND target_id IN (SELECT id FROM commands WHERE device_id = ?))
      OR (target_type = 'alert' AND target_id IN (SELECT id FROM alerts WHERE device_id = ?))
    )`);
    params.push(deviceId, deviceId, deviceId);
  }
  const where = filters.length ? `WHERE ${filters.join(' AND ')}` : '';
  const rows = db
    .prepare(`SELECT * FROM audit_logs ${where} ORDER BY created_at DESC, id DESC LIMIT ?`)
    .all(...params, limit);
  res.json({
    logs: rows.map((r) => ({ ...r, details: r.details ? JSON.parse(r.details) : null })),
  });
});
