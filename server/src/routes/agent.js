import { Router } from 'express';
import { z } from 'zod';
import { nanoid } from 'nanoid';
import { db } from '../db.js';
import { asyncHandler, httpError } from '../middleware/error.js';
import { requireDevice } from '../middleware/auth.js';
import { effectivePolicyForDevice, evaluateCompliance } from '../services/policyEngine.js';
import { raiseAlert } from '../services/alertService.js';
import { audit } from '../utils/audit.js';

export const agentRouter = Router();

const getToken = db.prepare('SELECT * FROM enrollment_tokens WHERE token = ?');
const markTokenUsed = db.prepare(
  'UPDATE enrollment_tokens SET used = 1, device_id = ? WHERE id = ?',
);
const getDeviceByUid = db.prepare('SELECT * FROM devices WHERE device_uid = ?');
const insertDevice = db.prepare(`
  INSERT INTO devices (device_uid, device_token, name, owner_name, department,
    manufacturer, model, os_version, sdk_int, serial, status, admin_active, last_seen, enrolled_at)
  VALUES (@device_uid, @device_token, @name, @owner_name, @department,
    @manufacturer, @model, @os_version, @sdk_int, @serial, 'active', 0, datetime('now'), datetime('now'))
`);
const getDefaultPolicyId = db.prepare('SELECT id FROM policies WHERE is_default = 1 LIMIT 1');
const assignPolicy = db.prepare(
  'INSERT OR REPLACE INTO device_policies (device_id, policy_id) VALUES (?, ?)',
);

const enrollSchema = z.object({
  enrollment_token: z.string().min(1),
  device_uid: z.string().min(3),
  name: z.string().optional(),
  owner_name: z.string().optional(),
  department: z.string().optional(),
  manufacturer: z.string().optional(),
  model: z.string().optional(),
  os_version: z.string().optional(),
  sdk_int: z.number().int().optional(),
  serial: z.string().optional(),
});

// POST /api/agent/enroll  -> secure device onboarding (Proposal 5.1)
agentRouter.post(
  '/enroll',
  asyncHandler(async (req, res) => {
    const body = enrollSchema.parse(req.body);
    const tokenRow = getToken.get(body.enrollment_token);
    if (!tokenRow) throw httpError(401, 'Invalid enrollment token');
    if (tokenRow.expires_at && new Date(tokenRow.expires_at + 'Z') < new Date()) {
      throw httpError(401, 'Enrollment token has expired');
    }

    // Re-enrollment of a known device rotates its token but keeps its record.
    let device = getDeviceByUid.get(body.device_uid);
    const deviceToken = nanoid(40);

    if (device) {
      db.prepare('UPDATE devices SET device_token = ?, status = CASE WHEN status = \'wiped\' THEN \'active\' ELSE status END, last_seen = datetime(\'now\') WHERE id = ?').run(
        deviceToken,
        device.id,
      );
    } else {
      if (tokenRow.used) throw httpError(401, 'Enrollment token already used');
      const info = insertDevice.run({
        device_uid: body.device_uid,
        device_token: deviceToken,
        name: body.name || body.model || 'Android Device',
        owner_name: body.owner_name || tokenRow.label || null,
        department: body.department || tokenRow.department || null,
        manufacturer: body.manufacturer || null,
        model: body.model || null,
        os_version: body.os_version || null,
        sdk_int: body.sdk_int || null,
        serial: body.serial || null,
      });
      device = db.prepare('SELECT * FROM devices WHERE id = ?').get(info.lastInsertRowid);
      markTokenUsed.run(device.id, tokenRow.id);
      const def = getDefaultPolicyId.get();
      if (def) assignPolicy.run(device.id, def.id);
    }

    audit({
      actorType: 'device',
      actorId: device.id,
      actorLabel: device.name,
      action: 'DEVICE_ENROLLED',
      targetType: 'device',
      targetId: device.id,
      details: { uid: device.device_uid, model: device.model },
      ip: req.ip,
    });
    raiseAlert({
      deviceId: device.id,
      severity: 'info',
      type: 'ENROLLMENT',
      message: `Device "${device.name}" enrolled successfully`,
    });

    res.status(201).json({
      device_id: device.id,
      device_token: deviceToken,
      policy: effectivePolicyForDevice(device.id),
      checkin_interval_seconds: 10,
    });
  }),
);

const checkinSchema = z.object({
  battery_level: z.number().int().min(0).max(100).optional(),
  battery_charging: z.boolean().optional(),
  network_type: z.string().optional(),
  os_version: z.string().optional(),
  admin_active: z.boolean().optional(),
  password_set: z.boolean().optional(),
  encryption_on: z.boolean().optional(),
  is_rooted: z.boolean().optional(),
  latitude: z.number().optional(),
  longitude: z.number().optional(),
});

// POST /api/agent/checkin  -> heartbeat + pull pending commands (Proposal 5.4 monitoring)
agentRouter.post(
  '/checkin',
  requireDevice,
  asyncHandler(async (req, res) => {
    const device = req.device;
    const r = checkinSchema.parse(req.body || {});
    const verdict = evaluateCompliance(device, r);

    db.prepare(
      `UPDATE devices SET last_seen = datetime('now'),
         battery_level = COALESCE(@battery_level, battery_level),
         battery_charging = COALESCE(@battery_charging, battery_charging),
         network_type = COALESCE(@network_type, network_type),
         os_version = COALESCE(@os_version, os_version),
         admin_active = COALESCE(@admin_active, admin_active),
         encryption_on = COALESCE(@encryption_on, encryption_on),
         is_rooted = COALESCE(@is_rooted, is_rooted),
         latitude = COALESCE(@latitude, latitude),
         longitude = COALESCE(@longitude, longitude),
         compliance = @compliance
       WHERE id = @id`,
    ).run({
      id: device.id,
      battery_level: r.battery_level ?? null,
      battery_charging: r.battery_charging === undefined ? null : r.battery_charging ? 1 : 0,
      network_type: r.network_type ?? null,
      os_version: r.os_version ?? null,
      admin_active: r.admin_active === undefined ? null : r.admin_active ? 1 : 0,
      encryption_on: r.encryption_on === undefined ? null : r.encryption_on ? 1 : 0,
      is_rooted: r.is_rooted === undefined ? null : r.is_rooted ? 1 : 0,
      latitude: r.latitude ?? null,
      longitude: r.longitude ?? null,
      compliance: verdict.status,
    });

    if (!verdict.compliant) {
      raiseAlert({
        deviceId: device.id,
        severity: 'warning',
        type: 'COMPLIANCE',
        message: `"${device.name}" non-compliant: ${verdict.violations.join('; ')}`,
      });
    }
    if (r.is_rooted) {
      raiseAlert({
        deviceId: device.id,
        severity: 'critical',
        type: 'ROOT_DETECTED',
        message: `"${device.name}" reported as rooted/compromised`,
      });
    }

    // Fetch and mark pending commands as sent.
    const pending = db
      .prepare(`SELECT * FROM commands WHERE device_id = ? AND status = 'pending' ORDER BY issued_at ASC`)
      .all(device.id);
    if (pending.length) {
      const ids = pending.map((c) => c.id);
      db.prepare(
        `UPDATE commands SET status = 'sent', sent_at = datetime('now') WHERE id IN (${ids.map(() => '?').join(',')})`,
      ).run(...ids);
    }

    res.json({
      commands: pending.map((c) => ({
        id: c.id,
        type: c.type,
        payload: JSON.parse(c.payload || '{}'),
      })),
      policy: effectivePolicyForDevice(device.id).config,
      compliance: verdict.status,
      checkin_interval_seconds: 10,
    });
  }),
);

const resultSchema = z.object({
  status: z.enum(['completed', 'failed', 'acknowledged']),
  result: z.string().optional(),
});

// POST /api/agent/commands/:id/result -> device reports command outcome (Proposal Device Response)
agentRouter.post(
  '/commands/:id/result',
  requireDevice,
  asyncHandler(async (req, res) => {
    const device = req.device;
    const cmd = db
      .prepare('SELECT * FROM commands WHERE id = ? AND device_id = ?')
      .get(req.params.id, device.id);
    if (!cmd) throw httpError(404, 'Command not found for this device');
    const { status, result } = resultSchema.parse(req.body);

    db.prepare(
      `UPDATE commands SET status = @status, result = @result,
         completed_at = CASE WHEN @status IN ('completed','failed') THEN datetime('now') ELSE completed_at END
       WHERE id = @id`,
    ).run({ id: cmd.id, status, result: result || null });

    // Reflect terminal device state from confirmed destructive commands.
    if (status === 'completed') {
      if (cmd.type === 'WIPE') db.prepare("UPDATE devices SET status = 'wiped' WHERE id = ?").run(device.id);
      if (cmd.type === 'ENABLE') db.prepare("UPDATE devices SET status = 'active' WHERE id = ?").run(device.id);
    }

    audit({
      actorType: 'device',
      actorId: device.id,
      actorLabel: device.name,
      action: `COMMAND_RESULT_${cmd.type}`,
      targetType: 'command',
      targetId: cmd.id,
      details: { status, result },
      ip: req.ip,
    });
    res.json({ ok: true });
  }),
);
