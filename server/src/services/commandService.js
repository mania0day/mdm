import { db } from '../db.js';
import { COMMAND_TYPES, ROLES } from '../config.js';
import { httpError } from '../middleware/error.js';
import { audit } from '../utils/audit.js';
import { notifyCommand } from './commandBus.js';

const insertCommand = db.prepare(`
  INSERT INTO commands (device_id, type, payload, issued_by, status)
  VALUES (@device_id, @type, @payload, @issued_by, 'pending')
`);
const getDevice = db.prepare('SELECT * FROM devices WHERE id = ?');
const setDeviceStatus = db.prepare('UPDATE devices SET status = ? WHERE id = ?');

/**
 * Queue a remote command for a device with RBAC + validation.
 * (Proposal 5.2 Remote Lock/Disable/Reset, 6.2 Remote Device Control)
 */
export function issueCommand({ device, type, payload = {}, user, ip }) {
  const spec = COMMAND_TYPES[type];
  if (!spec) throw httpError(400, `Unknown command type: ${type}`);

  const have = ROLES[user.role] || 0;
  const need = ROLES[spec.minRole] || 99;
  if (have < need) {
    throw httpError(403, `Command '${type}' requires '${spec.minRole}' role or higher`);
  }

  const info = insertCommand.run({
    device_id: device.id,
    type,
    payload: JSON.stringify(payload || {}),
    issued_by: user.id,
  });

  // Optimistically reflect intended state so the dashboard updates immediately;
  // the agent confirms via command result on its next check-in.
  if (type === 'DISABLE') setDeviceStatus.run('disabled', device.id);
  if (type === 'ENABLE') setDeviceStatus.run('active', device.id);
  if (type === 'LOCK') setDeviceStatus.run('locked', device.id);
  if (type === 'WIPE') setDeviceStatus.run('wipe_pending', device.id);

  // Wake any check-in this device is currently long-polling, so the command is
  // delivered in ~real time instead of on its next scheduled poll.
  notifyCommand(device.id);

  audit({
    actorType: 'user',
    actorId: user.id,
    actorLabel: user.username,
    action: `COMMAND_${type}`,
    targetType: 'device',
    targetId: device.id,
    details: { payload, destructive: spec.destructive, device: device.name },
    ip,
  });

  return getCommand.get(info.lastInsertRowid);
}

export const getCommand = db.prepare('SELECT * FROM commands WHERE id = ?');
export { getDevice };
