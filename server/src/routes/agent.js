import { Router } from 'express';
import { z } from 'zod';
import { nanoid } from 'nanoid';
import { db } from '../db.js';
import { asyncHandler, httpError } from '../middleware/error.js';
import { requireDevice } from '../middleware/auth.js';
import { effectivePolicyForDevice, evaluateCompliance } from '../services/policyEngine.js';
import { raiseAlert } from '../services/alertService.js';
import { waitForCommand } from '../services/commandBus.js';
import { audit } from '../utils/audit.js';

// Upper bound on how long a check-in may be held open waiting for a command
// (long-poll). The agent asks to hold only while its screen is on, so this adds
// no idle-battery cost; it turns command latency from "up to one poll interval"
// into "sub-second".
const MAX_LONGPOLL_SECONDS = 30;

export const agentRouter = Router();

const getToken = db.prepare('SELECT * FROM enrollment_tokens WHERE token = ?');
const markTokenUsed = db.prepare(
  'UPDATE enrollment_tokens SET used = 1, device_id = ? WHERE id = ?',
);
const getDeviceByUid = db.prepare('SELECT * FROM devices WHERE device_uid = ?');
const insertDevice = db.prepare(`
  INSERT INTO devices (device_uid, device_token, name, owner_name, department, employee_id,
    manufacturer, model, os_version, sdk_int, serial, is_rooted, imei, phone_number,
    sim_operator, build_fingerprint, security_patch, management_mode,
    status, admin_active, last_seen, enrolled_at)
  VALUES (@device_uid, @device_token, @name, @owner_name, @department, @employee_id,
    @manufacturer, @model, @os_version, @sdk_int, @serial, @is_rooted, @imei, @phone_number,
    @sim_operator, @build_fingerprint, @security_patch, @management_mode,
    'active', 0, datetime('now'), datetime('now'))
`);
const updateScanOnReenroll = db.prepare(`
  UPDATE devices SET device_token = ?,
    status = CASE WHEN status IN ('wiped', 'unenrolled') THEN 'active' ELSE status END,
    is_rooted = COALESCE(?, is_rooted),
    imei = COALESCE(?, imei),
    phone_number = COALESCE(?, phone_number),
    sim_operator = COALESCE(?, sim_operator),
    build_fingerprint = COALESCE(?, build_fingerprint),
    security_patch = COALESCE(?, security_patch),
    management_mode = COALESCE(?, management_mode),
    employee_id = COALESCE(?, employee_id),
    last_seen = datetime('now')
  WHERE id = ?
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
  is_rooted: z.boolean().optional(),
  imei: z.string().max(32).optional(),
  phone_number: z.string().max(32).optional(),
  sim_operator: z.string().max(64).optional(),
  build_fingerprint: z.string().max(256).optional(),
  security_patch: z.string().max(16).optional(),
  management_mode: z.enum(['device_owner', 'device_admin', 'none']).optional(),
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
      updateScanOnReenroll.run(
        deviceToken,
        body.is_rooted === undefined ? null : body.is_rooted ? 1 : 0,
        body.imei || null,
        body.phone_number || null,
        body.sim_operator || null,
        body.build_fingerprint || null,
        body.security_patch || null,
        body.management_mode || null,
        tokenRow.employee_id || null,
        device.id,
      );
      device = db.prepare('SELECT * FROM devices WHERE id = ?').get(device.id);
    } else {
      if (tokenRow.used) throw httpError(401, 'Enrollment token already used');
      const info = insertDevice.run({
        device_uid: body.device_uid,
        device_token: deviceToken,
        name: body.name || body.model || 'Android Device',
        owner_name: body.owner_name || tokenRow.label || null,
        department: body.department || tokenRow.department || null,
        // Identity is set by the admin at token-issue time, not
        // self-reported by the device — the token is the source of truth.
        employee_id: tokenRow.employee_id || null,
        manufacturer: body.manufacturer || null,
        model: body.model || null,
        os_version: body.os_version || null,
        sdk_int: body.sdk_int || null,
        serial: body.serial || null,
        is_rooted: body.is_rooted ? 1 : 0,
        imei: body.imei || null,
        phone_number: body.phone_number || null,
        sim_operator: body.sim_operator || null,
        build_fingerprint: body.build_fingerprint || null,
        security_patch: body.security_patch || null,
        management_mode: body.management_mode || 'none',
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
      owner_name: device.owner_name,
      employee_id: device.employee_id,
      policy: effectivePolicyForDevice(device.id),
      checkin_interval_seconds: 10,
    });
  }),
);

// How long a freshly-issued LOCK is allowed to be "in flight" before the
// device's self-reported lock state is trusted over the command's status.
const LOCK_SETTLE_GRACE_SECONDS = 120;

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
  imei: z.string().max(32).optional(),
  phone_number: z.string().max(32).optional(),
  sim_operator: z.string().max(64).optional(),
  build_fingerprint: z.string().max(256).optional(),
  security_patch: z.string().max(16).optional(),
  management_mode: z.enum(['device_owner', 'device_admin', 'none']).optional(),
  device_locked: z.boolean().optional(),
  // How many seconds the agent is willing to have this check-in held open waiting
  // for a command (long-poll). 0 / absent = return immediately, as before.
  wait: z.number().int().min(0).max(60).optional(),
});

// POST /api/agent/checkin  -> heartbeat + pull pending commands (Proposal 5.4 monitoring)
agentRouter.post(
  '/checkin',
  requireDevice,
  asyncHandler(async (req, res) => {
    const device = req.device;
    const r = checkinSchema.parse(req.body || {});
    const verdict = evaluateCompliance(device, r);

    // A check-in from a device the offline monitor had flagged means it is
    // reachable again: clear the flag and log the recovery once (mirrors the
    // monitor's one-shot "went offline").
    if (device.offline_since) {
      db.prepare('UPDATE devices SET offline_since = NULL WHERE id = ?').run(device.id);
      audit({
        actorType: 'device',
        actorId: device.id,
        actorLabel: device.name,
        action: 'DEVICE_BACK_ONLINE',
        targetType: 'device',
        targetId: device.id,
        details: { was_offline_since: device.offline_since },
        ip: req.ip,
      });
      raiseAlert({
        deviceId: device.id,
        severity: 'info',
        type: 'DEVICE_BACK_ONLINE',
        message: `"${device.name}" is back online`,
      });
    }

    // Detect the device having installed a real OS/security update between
    // check-ins — `device` here still holds the pre-update row (requireDevice
    // fetched it before this handler runs), so this is a straight before/after
    // comparison, not a guess.
    if (r.security_patch && device.security_patch && r.security_patch !== device.security_patch) {
      raiseAlert({
        deviceId: device.id,
        severity: 'info',
        type: 'DEVICE_UPDATED',
        message: `"${device.name}" security patch changed ${device.security_patch} → ${r.security_patch}`,
      });
    }
    if (r.os_version && device.os_version && r.os_version !== device.os_version) {
      raiseAlert({
        deviceId: device.id,
        severity: 'info',
        type: 'DEVICE_UPDATED',
        message: `"${device.name}" Android version changed ${device.os_version} → ${r.os_version}`,
      });
    }

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
         imei = COALESCE(@imei, imei),
         phone_number = COALESCE(@phone_number, phone_number),
         sim_operator = COALESCE(@sim_operator, sim_operator),
         build_fingerprint = COALESCE(@build_fingerprint, build_fingerprint),
         security_patch = COALESCE(@security_patch, security_patch),
         management_mode = COALESCE(@management_mode, management_mode),
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
      imei: r.imei || null,
      phone_number: r.phone_number || null,
      sim_operator: r.sim_operator || null,
      build_fingerprint: r.build_fingerprint || null,
      security_patch: r.security_patch || null,
      management_mode: r.management_mode || null,
      compliance: verdict.status,
    });

    // Reconcile commanded lock state against what the device actually reports.
    // LOCK sets status='locked', but the user can unlock their own phone at any
    // time and nothing else would ever clear it — leaving the console showing a
    // lock that isn't real. 'disabled' is deliberately excluded: that is an
    // administrative hold that only an explicit ENABLE may lift, and the agent
    // re-locks the device on every check-in while it is in force.
    if (r.device_locked === false && device.status === 'locked') {
      // Only clear once no LOCK is still in flight. The very check-in that
      // delivers a LOCK necessarily reports device_locked=false — the device
      // has not run the command yet — so clearing unconditionally here would
      // undo the lock's status the instant it was issued.
      // Bounded by a grace window: a LOCK whose result never came back (the
      // agent died, the network dropped) stays at 'sent' forever, and without
      // the time bound that one stuck row would block this device's status
      // from ever being corrected again.
      const inFlight = db
        .prepare(
          `SELECT COUNT(*) c FROM commands
           WHERE device_id = ? AND type = 'LOCK' AND status IN ('pending','sent')
             AND (julianday('now') - julianday(issued_at)) * 86400 < ?`,
        )
        .get(device.id, LOCK_SETTLE_GRACE_SECONDS).c;
      if (inFlight === 0) {
        db.prepare("UPDATE devices SET status = 'active' WHERE id = ?").run(device.id);
      }
    }

    // Fallback for device-admin removal. The agent posts /tamper on
    // ADMIN_DISABLED, but that is a single best-effort network call made while
    // the user is actively tearing the app down — if it fails, or the app is
    // uninstalled before it retries, the console would keep showing the device
    // as managed. A check-in that reports admin_active=false when we previously
    // recorded it as true is the same fact arriving by a slower route.
    if (device.admin_active === 1 && r.admin_active === false) {
      db.prepare("UPDATE devices SET status = 'unenrolled' WHERE id = ?").run(device.id);
      raiseAlert({
        deviceId: device.id,
        severity: 'critical',
        type: 'ADMIN_DISABLED',
        message: `"${device.name}" no longer reports device administrator rights — admin was removed on-device`,
      });
      audit({
        actorType: 'device',
        actorId: device.id,
        actorLabel: device.name,
        action: 'TAMPER_ADMIN_DISABLED',
        targetType: 'device',
        targetId: device.id,
        details: { detected_via: 'checkin telemetry' },
        ip: req.ip,
      });
    }

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

    // Fetch pending commands. If none are queued and the device asked us to hold
    // (it does while its screen is on), long-poll: wait until a command is issued
    // — woken instantly by commandBus.notifyCommand() from issueCommand() — or
    // until `wait` seconds pass, then re-check. This is what turns a click in the
    // dashboard into a sub-second action on the device instead of a wait for its
    // next scheduled poll.
    const fetchPending = () =>
      db
        .prepare(`SELECT * FROM commands WHERE device_id = ? AND status = 'pending' ORDER BY issued_at ASC`)
        .all(device.id);

    let pending = fetchPending();
    const wait = Math.min(r.wait ?? 0, MAX_LONGPOLL_SECONDS);
    if (pending.length === 0 && wait > 0) {
      const got = await waitForCommand(device.id, wait * 1000, res);
      // Device gave up / disconnected while we held the request — the socket is
      // gone, so there's nothing to reply to.
      if (res.writableEnded || !res.writable) return;
      if (got) pending = fetchPending();
    }

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
      // Sent so the agent can tell the user *why* it says "Needs attention"
      // instead of showing an unexplained status.
      violations: verdict.violations || [],
      allow_reconfigure: !!device.allow_reconfigure,
      checkin_interval_seconds: 10,
    });
  }),
);

// POST /api/agent/unenroll -> device-initiated departure from management.
// Immediately revokes the device's bearer token (rotated to an unshared
// value the agent never receives) so a copied/leaked token can't keep
// checking in after the app says "unenrolled". The device row and its
// history are kept for audit purposes; an admin can still see it was
// self-unenrolled and re-enrollment issues a fresh token.
agentRouter.post(
  '/unenroll',
  requireDevice,
  asyncHandler(async (req, res) => {
    const device = req.device;
    db.prepare(`UPDATE devices SET device_token = ?, status = 'unenrolled' WHERE id = ?`).run(
      nanoid(40),
      device.id,
    );
    audit({
      actorType: 'device',
      actorId: device.id,
      actorLabel: device.name,
      action: 'DEVICE_UNENROLLED',
      targetType: 'device',
      targetId: device.id,
      details: { uid: device.device_uid },
      ip: req.ip,
    });
    raiseAlert({
      deviceId: device.id,
      severity: 'warning',
      type: 'UNENROLLED',
      message: `Device "${device.name}" left management (self-unenrolled)`,
    });
    res.json({ ok: true });
  }),
);

const tamperSchema = z.object({
  type: z.string().min(1).max(64),
  message: z.string().min(1).max(500),
});

// POST /api/agent/tamper -> best-effort self-report fired from the device
// admin receiver. Two events land here:
//   ADMIN_DISABLE_REQUESTED — user opened the "deactivate admin" confirmation
//     dialog. Fires early and reliably, but they might still cancel, so this
//     is alert-only — it does not change the device's visible status.
//   ADMIN_DISABLED — deactivation actually completed, which is also the
//     mandatory first step before a non-Device-Owner install can be
//     uninstalled. This one DOES flip the device to 'unenrolled' and revokes
//     its token (same effect as /unenroll) so the dashboard immediately shows
//     the device is gone instead of staying stuck on 'active' forever with
//     the only evidence buried in the alerts list.
agentRouter.post(
  '/tamper',
  requireDevice,
  asyncHandler(async (req, res) => {
    const device = req.device;
    const { type, message } = tamperSchema.parse(req.body);

    if (type === 'ADMIN_DISABLED') {
      db.prepare(`UPDATE devices SET device_token = ?, status = 'unenrolled' WHERE id = ?`).run(
        nanoid(40),
        device.id,
      );
    }

    audit({
      actorType: 'device',
      actorId: device.id,
      actorLabel: device.name,
      action: `TAMPER_${type}`,
      targetType: 'device',
      targetId: device.id,
      details: { message },
      ip: req.ip,
    });
    raiseAlert({
      deviceId: device.id,
      severity: 'critical',
      type,
      message: `"${device.name}": ${message}`,
    });
    res.json({ ok: true });
  }),
);

// Severity per rule: what it actually means for the organization when this
// specific rule is breached, rather than one flat level for everything.
const VIOLATION_SEVERITY = {
  block_outgoing_calls: 'warning',
  wifi_ssid_allowlist: 'critical', // unapproved network = MITM / exfiltration risk
  block_new_app_installs: 'critical', // unvetted software on a corporate device
  block_unknown_sources: 'critical',
  disable_camera: 'warning',
  disable_mic: 'warning',
  force_airplane_mode_off: 'warning',
  disallow_usb_transfer: 'critical',
  disallow_debugging: 'critical',
  disable_screen_capture: 'warning',
};

const violationSchema = z.object({
  violations: z
    .array(
      z.object({
        rule: z.string().min(1).max(64),
        mode: z.enum(['enforce', 'monitor', 'off']).optional(),
        detail: z.string().max(500).optional(),
        metadata: z.record(z.any()).optional(),
        occurred_at: z.string().max(40).optional(),
      }),
    )
    .max(50),
});

// POST /api/agent/violations -> the device reports policy breaches it observed.
//
// This is what makes 'monitor' mode meaningful. A monitored rule is deliberately
// not blocked on the handset, so unless the agent tells us, the breach leaves no
// trace anywhere. Enforced rules can report here too, when the device is too old
// to actually block them (e.g. Wi-Fi SSID allowlisting needs Android 13+): the
// device still knows it joined an unapproved network even when it could not stop
// itself, and reporting that is far better than silently doing nothing.
//
// Each breach is stored as durable evidence (policy_violations, read by the
// device's Violations tab) AND raised as an operator alert — record vs
// notification. raiseAlert() already de-duplicates repeats within its window, so
// a device that keeps re-breaching does not flood the alert list.
agentRouter.post(
  '/violations',
  requireDevice,
  asyncHandler(async (req, res) => {
    const device = req.device;
    const { violations } = violationSchema.parse(req.body || {});
    if (!violations.length) return res.json({ ok: true, recorded: 0 });

    const insert = db.prepare(`
      INSERT INTO policy_violations (device_id, rule, mode, severity, detail, metadata, occurred_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `);

    const recordAll = db.transaction((rows) => {
      for (const v of rows) {
        const severity = VIOLATION_SEVERITY[v.rule] || 'warning';
        insert.run(
          device.id,
          v.rule,
          // Fail safe, exactly as ruleMode() does: an unreported mode must not
          // be recorded as 'monitor', because the console renders that as
          // "allowed by design — the device reported it instead of blocking it",
          // which asserts an intent we have no evidence for. 'enforce' reads as
          // "this should have been blocked and wasn't", which is the honest
          // reading of a breach whose mode we don't know.
          v.mode || 'enforce',
          severity,
          v.detail || null,
          v.metadata ? JSON.stringify(v.metadata) : null,
          v.occurred_at || null,
        );
      }
    });
    recordAll(violations);

    for (const v of violations) {
      const severity = VIOLATION_SEVERITY[v.rule] || 'warning';
      raiseAlert({
        deviceId: device.id,
        severity,
        type: `POLICY_VIOLATION_${v.rule.toUpperCase()}`,
        message: `"${device.name}" policy violation — ${v.detail || v.rule}`,
      });
      audit({
        actorType: 'device',
        actorId: device.id,
        actorLabel: device.name,
        action: 'POLICY_VIOLATION',
        targetType: 'device',
        targetId: device.id,
        details: { rule: v.rule, mode: v.mode, detail: v.detail, ...(v.metadata || {}) },
        ip: req.ip,
      });
    }

    res.json({ ok: true, recorded: violations.length });
  }),
);

const gameScoreSchema = z.object({
  score: z.number().int().min(0).max(1_000_000),
});

// POST /api/agent/game-score -> sync the on-device dino-runner high score.
// Only ever ratchets up — a lower score never overwrites a previously
// synced best, same as the game's own local high score behaves.
agentRouter.post(
  '/game-score',
  requireDevice,
  asyncHandler(async (req, res) => {
    const device = req.device;
    const { score } = gameScoreSchema.parse(req.body);
    db.prepare('UPDATE devices SET high_score = MAX(high_score, ?) WHERE id = ?').run(score, device.id);
    res.json({ ok: true, high_score: Math.max(device.high_score || 0, score) });
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
