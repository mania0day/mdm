import { Router } from 'express';
import bcrypt from 'bcryptjs';
import { z } from 'zod';
import { db } from '../db.js';
import { ROLES } from '../config.js';
import { asyncHandler, httpError } from '../middleware/error.js';
import { requireAuth, requireRole } from '../middleware/auth.js';
import { audit } from '../utils/audit.js';

export const usersRouter = Router();
usersRouter.use(requireAuth);

const listStmt = db.prepare(
  'SELECT id, username, full_name, role, active, last_login, created_at FROM users ORDER BY id ASC',
);

usersRouter.get('/', requireRole('admin'), (req, res) => {
  res.json({ users: listStmt.all(), roles: Object.keys(ROLES) });
});

const createSchema = z.object({
  username: z.string().min(3).max(32),
  password: z.string().min(6),
  full_name: z.string().min(1),
  role: z.enum(['auditor', 'operator', 'admin', 'super_admin']),
});

usersRouter.post(
  '/',
  requireRole('super_admin'),
  asyncHandler(async (req, res) => {
    const body = createSchema.parse(req.body);
    const exists = db.prepare('SELECT id FROM users WHERE username = ?').get(body.username);
    if (exists) throw httpError(409, 'Username already exists');
    const hash = await bcrypt.hash(body.password, 10);
    const info = db
      .prepare(
        'INSERT INTO users (username, password_hash, full_name, role) VALUES (?, ?, ?, ?)',
      )
      .run(body.username, hash, body.full_name, body.role);
    audit({
      actorType: 'user',
      actorId: req.user.id,
      actorLabel: req.user.username,
      action: 'CREATE_USER',
      targetType: 'user',
      targetId: info.lastInsertRowid,
      details: { username: body.username, role: body.role },
      ip: req.ip,
    });
    res.status(201).json({
      user: db
        .prepare('SELECT id, username, full_name, role, active, created_at FROM users WHERE id = ?')
        .get(info.lastInsertRowid),
    });
  }),
);

usersRouter.patch(
  '/:id',
  requireRole('super_admin'),
  asyncHandler(async (req, res) => {
    const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.params.id);
    if (!user) throw httpError(404, 'User not found');
    const schema = z.object({
      role: z.enum(['auditor', 'operator', 'admin', 'super_admin']).optional(),
      active: z.boolean().optional(),
      password: z.string().min(6).optional(),
    });
    const body = schema.parse(req.body);
    if (user.id === req.user.id && body.active === false) {
      throw httpError(400, 'You cannot deactivate your own account');
    }
    if (body.role) db.prepare('UPDATE users SET role = ? WHERE id = ?').run(body.role, user.id);
    if (body.active !== undefined)
      db.prepare('UPDATE users SET active = ? WHERE id = ?').run(body.active ? 1 : 0, user.id);
    if (body.password) {
      const hash = await bcrypt.hash(body.password, 10);
      db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(hash, user.id);
    }
    audit({
      actorType: 'user',
      actorId: req.user.id,
      actorLabel: req.user.username,
      action: 'UPDATE_USER',
      targetType: 'user',
      targetId: user.id,
      details: body.password ? { ...body, password: '***' } : body,
      ip: req.ip,
    });
    res.json({ ok: true });
  }),
);
