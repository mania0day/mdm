import { Router } from 'express';
import { z } from 'zod';
import { nanoid } from 'nanoid';
import { db } from '../db.js';
import { config } from '../config.js';
import { asyncHandler, httpError } from '../middleware/error.js';
import { requireAuth, requireRole } from '../middleware/auth.js';
import { issueCommand } from '../services/commandService.js';
import { effectivePolicyForDevice, evaluateCompliance } from '../services/policyEngine.js';
import { getCveExposure } from '../services/cveService.js';
import { audit } from '../utils/audit.js';

export const devicesRouter = Router();
devicesRouter.use(requireAuth);

const listStmt = db.prepare(`SELECT * FROM devices ORDER BY enrolled_at DESC`);
const getStmt = db.prepare('SELECT * FROM devices WHERE id = ?');
// Unenroll is soft by design: revoke the device's token so it can never
// check in again, mark it unenrolled, but keep the row (and therefore its
// full command/alert/audit history) intact and browsable. Re-enrolling the
// same physical install (same device_uid, from Prefs.deviceUid which
// survives a local unenroll) reuses this same row rather than creating a
// duplicate — see agent.js POST /enroll.
const unenrollStmt = db.prepare(`UPDATE devices SET device_token = ?, status = 'unenrolled' WHERE id = ?`);
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
    cve: getCveExposure(device.os_version, device.security_patch),
  });
});

// Policy fields Android only lets a Device Owner actually enforce via
// DevicePolicyManager — a plain Device Admin throws SecurityException for
// all of these (mirrors android-agent PolicyManager.kt's tryApply() outcomes).
const OWNER_ONLY_POLICY_KEYS = new Set([
  'min_password_length',
  'require_password',
  'password_quality',
  'disable_camera',
  'disable_mic',
  'force_location_on',
  'force_airplane_mode_off',
  'disallow_safe_boot',
  'disallow_factory_reset',
  'disallow_add_user',
]);
// Fields that are compliance signals only — never device-enforced by SENTROID,
// just monitored and flagged.
const MONITORED_ONLY_KEYS = new Set(['require_encryption', 'block_rooted']);

const alertsForDeviceStmt = db.prepare(
  `SELECT * FROM alerts WHERE device_id = ? ORDER BY acknowledged ASC, created_at DESC LIMIT 20`,
);

/** Deterministic 0-100 security posture score for the report / score ring. */
function scoreDevice(device, verdict, unackCritical, cve) {
  let score = 100;
  if (device.is_rooted) score -= 40;
  if (!device.encryption_on) score -= 20;
  if (device.management_mode === 'none') score -= 15;
  else if (device.management_mode === 'device_admin') score -= 10; // can't enforce the owner-only tier
  if (device.battery_level != null && device.battery_level <= 15 && !device.battery_charging) score -= 5;
  score -= Math.min(20, unackCritical * 10);
  if (cve?.os_eol) score -= 15;
  else if (cve?.overall_level === 'HIGH') score -= 10;
  else if (cve?.overall_level === 'MEDIUM') score -= 5;
  return Math.max(0, Math.min(100, score));
}

// GET /api/devices/:id/report -> aggregated security posture for the in-app report page
devicesRouter.get('/:id/report', (req, res) => {
  const device = getStmt.get(req.params.id);
  if (!device) throw httpError(404, 'Device not found');
  const policy = effectivePolicyForDevice(device.id);
  const verdict = evaluateCompliance(device, {
    encryption_on: !!device.encryption_on,
    is_rooted: !!device.is_rooted,
    battery_level: device.battery_level,
    battery_charging: !!device.battery_charging,
  });

  const alerts = alertsForDeviceStmt.all(device.id);
  const unackCritical = alerts.filter((a) => !a.acknowledged && a.severity === 'critical').length;
  const commands = commandsForDevice.all(device.id);
  const cve = getCveExposure(device.os_version, device.security_patch);

  const enforcement = Object.entries(policy.config).map(([key, value]) => {
    let tier = 'enforced';
    if (MONITORED_ONLY_KEYS.has(key)) tier = 'monitored';
    else if (OWNER_ONLY_POLICY_KEYS.has(key)) tier = 'owner_only';
    const applied = tier !== 'owner_only' || device.management_mode === 'device_owner';
    return { key, value, tier, applied };
  });

  res.json({
    device: decorate(device),
    policy,
    compliance: { ...verdict, score: scoreDevice(device, verdict, unackCritical, cve) },
    enforcement,
    cve,
    alerts: { total: alerts.length, unacknowledged: alerts.filter((a) => !a.acknowledged).length, recent: alerts },
    commands: { total: commands.length, recent: commands.slice(0, 15) },
    generated_at: new Date().toISOString(),
  });
});

// POST /api/devices/:id/reconfigure -> gate the on-device technical setup view (admin+)
devicesRouter.post(
  '/:id/reconfigure',
  requireRole('admin'),
  asyncHandler(async (req, res) => {
    const device = getStmt.get(req.params.id);
    if (!device) throw httpError(404, 'Device not found');
    const { allow } = z.object({ allow: z.boolean() }).parse(req.body);
    db.prepare('UPDATE devices SET allow_reconfigure = ? WHERE id = ?').run(allow ? 1 : 0, device.id);
    audit({
      actorType: 'user',
      actorId: req.user.id,
      actorLabel: req.user.username,
      action: allow ? 'ALLOW_RECONFIGURE' : 'REVOKE_RECONFIGURE',
      targetType: 'device',
      targetId: device.id,
      ip: req.ip,
    });
    res.json({ ok: true, allow_reconfigure: allow });
  }),
);

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
// DELETE /api/devices/:id -> unenroll (admin+). Soft: revokes the device's
// token and marks it unenrolled, but the record and its full history stay —
// nothing is deleted.
devicesRouter.delete(
  '/:id',
  requireRole('admin'),
  asyncHandler(async (req, res) => {
    const device = getStmt.get(req.params.id);
    if (!device) throw httpError(404, 'Device not found');
    unenrollStmt.run(nanoid(40), device.id);
    audit({
      actorType: 'user',
      actorId: req.user.id,
      actorLabel: req.user.username,
      action: 'DEVICE_UNENROLLED',
      targetType: 'device',
      targetId: device.id,
      details: { name: device.name, uid: device.device_uid },
      ip: req.ip,
    });
    res.json({ ok: true });
  }),
);
