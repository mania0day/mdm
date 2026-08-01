import { Router } from 'express';
import { z } from 'zod';
import { nanoid } from 'nanoid';
import { db } from '../db.js';
import { asyncHandler } from '../middleware/error.js';
import { requireAuth, requireRole } from '../middleware/auth.js';
import { audit } from '../utils/audit.js';

export const enrollmentRouter = Router();
enrollmentRouter.use(requireAuth);

const listStmt = db.prepare(`
  SELECT t.*, d.name AS device_name, u.username AS created_by_name
  FROM enrollment_tokens t
  LEFT JOIN devices d ON d.id = t.device_id
  LEFT JOIN users u ON u.id = t.created_by
  ORDER BY t.created_at DESC LIMIT 100
`);

enrollmentRouter.get('/tokens', (req, res) => {
  res.json({ tokens: listStmt.all() });
});

const createSchema = z.object({
  label: z.string().optional(),
  department: z.string().optional(),
  expires_in_hours: z.number().int().positive().optional(),
});

// POST /api/enrollment/tokens -> generate a single-use enrollment token (admin+)
enrollmentRouter.post(
  '/tokens',
  requireRole('admin'),
  asyncHandler(async (req, res) => {
    const body = createSchema.parse(req.body || {});
    const token = `ENR-${nanoid(16)}`;
    const expires = body.expires_in_hours
      ? new Date(Date.now() + body.expires_in_hours * 3600 * 1000).toISOString().slice(0, 19).replace('T', ' ')
      : null;
    const info = db
      .prepare(
        `INSERT INTO enrollment_tokens (token, label, department, created_by, expires_at)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run(token, body.label || null, body.department || null, req.user.id, expires);
    audit({
      actorType: 'user',
      actorId: req.user.id,
      actorLabel: req.user.username,
      action: 'CREATE_ENROLLMENT_TOKEN',
      targetType: 'enrollment_token',
      targetId: info.lastInsertRowid,
      details: { label: body.label },
      ip: req.ip,
    });
    res.status(201).json({
      token: db.prepare('SELECT * FROM enrollment_tokens WHERE id = ?').get(info.lastInsertRowid),
    });
  }),
);

enrollmentRouter.delete(
  '/tokens/:id',
  requireRole('admin'),
  asyncHandler(async (req, res) => {
    db.prepare('DELETE FROM enrollment_tokens WHERE id = ? AND used = 0').run(req.params.id);
    res.json({ ok: true });
  }),
);
