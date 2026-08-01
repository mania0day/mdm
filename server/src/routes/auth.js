import { Router } from 'express';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { z } from 'zod';
import { config } from '../config.js';
import { db } from '../db.js';
import { asyncHandler, httpError } from '../middleware/error.js';
import { requireAuth } from '../middleware/auth.js';
import { audit } from '../utils/audit.js';

export const authRouter = Router();

const getByUsername = db.prepare('SELECT * FROM users WHERE username = ?');
const touchLogin = db.prepare("UPDATE users SET last_login = datetime('now') WHERE id = ?");

const loginSchema = z.object({
  username: z.string().min(1),
  password: z.string().min(1),
});

function publicUser(u) {
  return { id: u.id, username: u.username, full_name: u.full_name, role: u.role };
}

authRouter.post(
  '/login',
  asyncHandler(async (req, res) => {
    const { username, password } = loginSchema.parse(req.body);
    const user = getByUsername.get(username);
    if (!user || !user.active) throw httpError(401, 'Invalid credentials');
    const ok = await bcrypt.compare(password, user.password_hash);
    if (!ok) {
      audit({
        actorType: 'user',
        actorLabel: username,
        action: 'LOGIN_FAILED',
        ip: req.ip,
      });
      throw httpError(401, 'Invalid credentials');
    }
    touchLogin.run(user.id);
    const token = jwt.sign({ sub: user.id, role: user.role }, config.jwtSecret, {
      expiresIn: config.jwtExpiresIn,
    });
    audit({
      actorType: 'user',
      actorId: user.id,
      actorLabel: user.username,
      action: 'LOGIN',
      ip: req.ip,
    });
    res.json({ token, user: publicUser(user) });
  }),
);

authRouter.get('/me', requireAuth, (req, res) => {
  res.json({ user: publicUser(req.user) });
});

authRouter.post('/logout', requireAuth, (req, res) => {
  audit({
    actorType: 'user',
    actorId: req.user.id,
    actorLabel: req.user.username,
    action: 'LOGOUT',
    ip: req.ip,
  });
  res.json({ ok: true });
});
