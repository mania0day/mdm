import { Router } from 'express';
import { db } from '../db.js';
import { requireAuth } from '../middleware/auth.js';

export const auditRouter = Router();
auditRouter.use(requireAuth);

// GET /api/audit-logs?limit=&action=&device_id=
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
  const where = filters.length ? `WHERE ${filters.join(' AND ')}` : '';
  const rows = db
    .prepare(`SELECT * FROM audit_logs ${where} ORDER BY created_at DESC, id DESC LIMIT ?`)
    .all(...params, limit);
  res.json({
    logs: rows.map((r) => ({ ...r, details: r.details ? JSON.parse(r.details) : null })),
  });
});
