import jwt from 'jsonwebtoken';
import { config, ROLES } from '../config.js';
import { db } from '../db.js';

const getUser = db.prepare('SELECT * FROM users WHERE id = ? AND active = 1');
const getDeviceByToken = db.prepare('SELECT * FROM devices WHERE device_token = ?');

/**
 * Require a valid admin JWT. Attaches req.user.
 */
export function requireAuth(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) return res.status(401).json({ error: 'Authentication required' });
  try {
    const payload = jwt.verify(token, config.jwtSecret);
    const user = getUser.get(payload.sub);
    if (!user) return res.status(401).json({ error: 'User no longer active' });
    req.user = user;
    next();
  } catch {
    return res.status(401).json({ error: 'Invalid or expired token' });
  }
}

/**
 * Require the authenticated admin to hold at least `role`.
 * Roles are ranked in config.ROLES.
 */
export function requireRole(role) {
  return (req, res, next) => {
    if (!req.user) return res.status(401).json({ error: 'Authentication required' });
    const have = ROLES[req.user.role] || 0;
    const need = ROLES[role] || 99;
    if (have < need) {
      return res
        .status(403)
        .json({ error: `Insufficient privileges: requires '${role}' role or higher` });
    }
    next();
  };
}

/**
 * Authenticate an enrolled Android agent by its device token.
 * Attaches req.device.
 */
export function requireDevice(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) return res.status(401).json({ error: 'Device token required' });
  const device = getDeviceByToken.get(token);
  if (!device) return res.status(401).json({ error: 'Unknown device token' });
  req.device = device;
  next();
}
