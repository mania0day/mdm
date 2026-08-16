import { Router } from 'express';
import { z } from 'zod';
import { nanoid } from 'nanoid';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import QRCode from 'qrcode';
import { db } from '../db.js';
import { config } from '../config.js';
import { asyncHandler, httpError } from '../middleware/error.js';
import { requireAuth, requireRole } from '../middleware/auth.js';
import { audit } from '../utils/audit.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// build-apk.sh writes the live signing-cert checksum next to the served APK.
const APK_CHECKSUM_FILE = path.join(__dirname, '..', '..', '..', 'apk', 'sentroid-agent.apk.checksum');

export const enrollmentRouter = Router();
enrollmentRouter.use(requireAuth);

/** Live APK signing checksum (from build-apk.sh) if present, else the config fallback. */
function apkSignatureChecksum() {
  try {
    const v = fs.readFileSync(APK_CHECKSUM_FILE, 'utf8').trim();
    if (v) return v;
  } catch {
    /* fall through to the configured/default checksum */
  }
  return config.provisioning.apkSignatureChecksum;
}

/** Base URL a device on the LAN should use to reach this server (APK + API). */
function serverBaseUrl(req, override) {
  if (override) return String(override).replace(/\/+$/, '');
  const proto = req.headers['x-forwarded-proto'] || req.protocol || 'http';
  return `${proto}://${req.get('host')}`;
}

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

const getTokenById = db.prepare('SELECT * FROM enrollment_tokens WHERE id = ?');

// GET /api/enrollment/tokens/:id/provisioning -> Android Device Owner QR payload.
// This is the JSON an Android setup wizard reads after 6 taps on the welcome
// screen of a freshly-wiped device: it downloads the agent APK from this server,
// verifies its signing certificate against the checksum, is made *Device Owner*,
// and receives the server URL + this enrollment token in the admin-extras bundle
// so the agent auto-enrolls with no typing (see the agent's
// onProfileProvisioningComplete). Admin only. (Proposal 5.1 Secure Onboarding)
const provisioningQuery = z.object({
  // Base URL a device on the LAN should use to reach this server. Must be
  // network-reachable from the phone (LAN IP or public host) — NOT localhost.
  server: z.string().url().optional(),
  wifi_ssid: z.string().min(1).max(64).optional(),
  wifi_password: z.string().max(128).optional(),
  wifi_security: z.enum(['NONE', 'WPA', 'WEP', 'EAP']).optional(),
});

enrollmentRouter.get(
  '/tokens/:id/provisioning',
  requireRole('admin'),
  asyncHandler(async (req, res) => {
    const token = getTokenById.get(req.params.id);
    if (!token) throw httpError(404, 'Enrollment token not found');
    if (token.used) throw httpError(409, 'Token already used — generate a fresh one for provisioning');
    const q = provisioningQuery.parse(req.query);

    const base = serverBaseUrl(req, q.server);
    const payload = {
      'android.app.extra.PROVISIONING_DEVICE_ADMIN_COMPONENT_NAME': config.provisioning.adminComponent,
      'android.app.extra.PROVISIONING_DEVICE_ADMIN_SIGNATURE_CHECKSUM': apkSignatureChecksum(),
      'android.app.extra.PROVISIONING_DEVICE_ADMIN_PACKAGE_DOWNLOAD_LOCATION': `${base}/sentroid-agent.apk`,
      // Keep the (data-free) wizard moving without extra prompts.
      'android.app.extra.PROVISIONING_LEAVE_ALL_SYSTEM_APPS_ENABLED': true,
      // Delivered to the agent's onProfileProvisioningComplete. Keys match the
      // agent's EXTRA_SERVER_URL / EXTRA_ENROLL_TOKEN so it auto-enrolls.
      'android.app.extra.PROVISIONING_ADMIN_EXTRAS_BUNDLE': {
        server_url: base,
        enrollment_token: token.token,
      },
    };
    // Optional: seed Wi-Fi so a freshly-wiped device can reach this server to
    // download the APK without the operator typing Wi-Fi into the wizard.
    if (q.wifi_ssid) {
      payload['android.app.extra.PROVISIONING_WIFI_SSID'] = q.wifi_ssid;
      payload['android.app.extra.PROVISIONING_WIFI_SECURITY_TYPE'] = q.wifi_security || 'WPA';
      if (q.wifi_password) payload['android.app.extra.PROVISIONING_WIFI_PASSWORD'] = q.wifi_password;
    }

    const qr = await QRCode.toDataURL(JSON.stringify(payload), {
      errorCorrectionLevel: 'M',
      margin: 2,
      width: 360,
    });

    const apkPath = path.join(__dirname, '..', '..', '..', 'apk', 'sentroid-agent.apk');
    res.json({
      payload,
      qr,
      download_url: `${base}/sentroid-agent.apk`,
      apk_available: fs.existsSync(apkPath),
      checksum: apkSignatureChecksum(),
    });
  }),
);

const createSchema = z.object({
  label: z.string().optional(),
  department: z.string().optional(),
  employee_id: z.string().max(64).optional(),
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
        `INSERT INTO enrollment_tokens (token, label, department, employee_id, created_by, expires_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(token, body.label || null, body.department || null, body.employee_id || null, req.user.id, expires);
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
