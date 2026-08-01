import { Router } from 'express';
import { z } from 'zod';
import { db } from '../db.js';
import { config } from '../config.js';
import { asyncHandler, httpError } from '../middleware/error.js';
import { requireAuth, requireRole } from '../middleware/auth.js';
import { issueCommand } from '../services/commandService.js';
import { effectivePolicyForDevice } from '../services/policyEngine.js';
import { audit } from '../utils/audit.js';

export const devicesRouter = Router();
devicesRouter.use(requireAuth);

const listStmt = db.prepare(`SELECT * FROM devices ORDER BY enrolled_at DESC`);
const getStmt = db.prepare('SELECT * FROM devices WHERE id = ?');
const deleteStmt = db.prepare('DELETE FROM devices WHERE id = ?');
// enrollment_tokens.device_id references devices(id) WITHOUT ON DELETE CASCADE,
// so we must clear the reference before deleting the device or the FK fails.
const detachTokensStmt = db.prepare('UPDATE enrollment_tokens SET device_id = NULL WHERE device_id = ?');
// Delete a device and everything that points to it, atomically.
const deleteDeviceTx = db.transaction((deviceId) => {
  detachTokensStmt.run(deviceId);
  deleteStmt.run(deviceId); // device_policies / commands / alerts cascade automatically
});
const commandsForDevice = db.prepare(
  `SELECT c.*, u.username AS issued_by_name FROM commands c
   LEFT JOIN users u ON u.id = c.issued_by
   WHERE c.device_id = ? ORDER BY c.issued_at DESC LIMIT 100`,
);
const assignPolicyStmt = db.prepare(
  `INSERT OR REPLACE INTO device_policies (device_id, policy_id) VALUES (?, ?)`,
);
const clearPoliciesStmt = db.prepare('DELETE FROM device_policies WHERE device_id = ?');

/** Decorate a device row with derived online/offline state. */
function decorate(device) {
  const thresholdMs = config.deviceOfflineThresholdSeconds * 1000;
  let online = false;
  if (device.last_seen) {
    const last = new Date(device.last_seen + 'Z').getTime();
    online = Date.now() - last < thresholdMs;
  }
  return { ...device, online };
}

// GET /api/devices  -> inventory list
devicesRouter.get('/', (req, res) => {
  res.json({ devices: listStmt.all().map(decorate) });
});

// GET /api/devices/:id -> full detail incl. effective policy + command history
devicesRouter.get('/:id', (req, res) => {
  const device = getStmt.get(req.params.id);
  if (!device) throw httpError(404, 'Device not found');
  res.json({
    device: decorate(device),
    policy: effectivePolicyForDevice(device.id),
    commands: commandsForDevice.all(device.id),
  });
});

const commandSchema = z.object({
  type: z.string().min(1),
  payload: z.record(z.any()).optional().default({}),
});

// POST /api/devices/:id/commands -> issue remote command
devicesRouter.post(
  '/:id/commands',
  asyncHandler(async (req, res) => {
    const device = getStmt.get(req.params.id);
    if (!device) throw httpError(404, 'Device not found');
    const { type, payload } = commandSchema.parse(req.body);
    const command = issueCommand({ device, type, payload, user: req.user, ip: req.ip });
    res.status(201).json({ command });
  }),
);

// GET /api/devices/:id/commands -> command history
devicesRouter.get('/:id/commands', (req, res) => {
  const device = getStmt.get(req.params.id);
  if (!device) throw httpError(404, 'Device not found');
  res.json({ commands: commandsForDevice.all(device.id) });
});

// POST /api/devices/:id/policy -> assign a policy (admin+)
devicesRouter.post(
  '/:id/policy',
  requireRole('admin'),
  asyncHandler(async (req, res) => {
    const device = getStmt.get(req.params.id);
    if (!device) throw httpError(404, 'Device not found');
    const schema = z.object({ policy_id: z.number().int().nullable() });
    const { policy_id } = schema.parse(req.body);
    clearPoliciesStmt.run(device.id);
    if (policy_id) {
      const exists = db.prepare('SELECT id FROM policies WHERE id = ?').get(policy_id);
      if (!exists) throw httpError(404, 'Policy not found');
      assignPolicyStmt.run(device.id, policy_id);
    }
    audit({
      actorType: 'user',
      actorId: req.user.id,
      actorLabel: req.user.username,
      action: 'ASSIGN_POLICY',
      targetType: 'device',
      targetId: device.id,
      details: { policy_id },
      ip: req.ip,
    });
    // Push the new policy to the device via an ENFORCE_POLICY command.
    issueCommand({ device, type: 'ENFORCE_POLICY', user: req.user, ip: req.ip });
    res.json({ policy: effectivePolicyForDevice(device.id) });
  }),
);

// DELETE /api/devices/:id -> deregister device (admin+)
devicesRouter.delete(
  '/:id',
  requireRole('admin'),
  asyncHandler(async (req, res) => {
    const device = getStmt.get(req.params.id);
    if (!device) throw httpError(404, 'Device not found');
    deleteDeviceTx(device.id);
    audit({
      actorType: 'user',
      actorId: req.user.id,
      actorLabel: req.user.username,
      action: 'DEREGISTER_DEVICE',
      targetType: 'device',
      targetId: device.id,
      details: { name: device.name, uid: device.device_uid },
      ip: req.ip,
    });
    res.json({ ok: true });
  }),
);
