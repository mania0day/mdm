// Optional demo-data seeder: populates a realistic sample fleet so the dashboard
// can be explored without a live device. Safe to run repeatedly (it clears and
// re-inserts demo rows). Run with:  npm run demo
import { nanoid } from 'nanoid';
import { db, initSchema } from './db.js';
import { seed } from './seed.js';

initSchema();
seed(); // ensure admin + policies exist

const now = "datetime('now')";

// Clear existing device-related demo data (keeps users + policies).
db.exec(`
  DELETE FROM commands;
  DELETE FROM alerts;
  DELETE FROM device_policies;
  DELETE FROM devices;
  DELETE FROM audit_logs;
`);

const adminId = db.prepare("SELECT id FROM users WHERE role='super_admin' LIMIT 1").get()?.id || 1;
const defaultPolicy = db.prepare('SELECT id FROM policies WHERE is_default=1 LIMIT 1').get()?.id;
const hardPolicy = db.prepare("SELECT id FROM policies WHERE name LIKE 'High-Security%' LIMIT 1").get()?.id;

const insertDevice = db.prepare(`
  INSERT INTO devices (device_uid, device_token, name, owner_name, department, manufacturer,
    model, os_version, sdk_int, serial, status, admin_active, compliance, battery_level,
    battery_charging, network_type, is_rooted, encryption_on, latitude, longitude,
    last_seen, enrolled_at)
  VALUES (@uid, @tok, @name, @owner, @dept, @man, @model, @os, @sdk, @serial, @status,
    @admin, @comp, @bat, @charging, @net, @rooted, @enc, @lat, @lng,
    datetime('now', @seen), datetime('now', @enrolled))
`);

const fleet = [
  { name: 'Field Unit Alpha', owner: 'Insp. R. Mehmood', dept: 'Field Operations', man: 'Samsung', model: 'Galaxy S22', os: '14', sdk: 34, status: 'active', comp: 'compliant', bat: 78, charging: 0, net: 'cellular', rooted: 0, enc: 1, lat: 33.6844, lng: 73.0479, seen: '-8 seconds', enrolled: '-6 days', policy: hardPolicy },
  { name: 'HQ Tablet 04', owner: 'Ops Desk', dept: 'Headquarters', man: 'Lenovo', model: 'Tab P11', os: '13', sdk: 33, status: 'locked', comp: 'compliant', bat: 42, charging: 1, net: 'wifi', rooted: 0, enc: 1, lat: 33.7294, lng: 73.0931, seen: '-25 seconds', enrolled: '-14 days', policy: defaultPolicy },
  { name: 'Officer Khan Phone', owner: 'S. Khan', dept: 'Investigations', man: 'Google', model: 'Pixel 6', os: '14', sdk: 34, status: 'active', comp: 'non_compliant', bat: 63, charging: 0, net: 'wifi', rooted: 1, enc: 0, lat: 31.5204, lng: 74.3587, seen: '-15 seconds', enrolled: '-3 days', policy: defaultPolicy },
  { name: 'Recon Device 12', owner: 'Field Team B', dept: 'Field Operations', man: 'Xiaomi', model: 'Redmi Note 12', os: '13', sdk: 33, status: 'active', comp: 'compliant', bat: 12, charging: 0, net: 'cellular', rooted: 0, enc: 1, lat: 34.0151, lng: 71.5249, seen: '-40 seconds', enrolled: '-9 days', policy: hardPolicy },
  { name: 'Retired Handset 07', owner: 'Store', dept: 'Logistics', man: 'Nokia', model: 'G21', os: '12', sdk: 31, status: 'disabled', comp: 'unknown', bat: 0, charging: 0, net: 'none', rooted: 0, enc: 0, lat: null, lng: null, seen: '-4 days', enrolled: '-40 days', policy: defaultPolicy },
];

const deviceIds = [];
for (const d of fleet) {
  const info = insertDevice.run({
    uid: 'demo-' + nanoid(8), tok: nanoid(40), name: d.name, owner: d.owner, dept: d.dept,
    man: d.man, model: d.model, os: d.os, sdk: d.sdk, serial: 'SN' + nanoid(6).toUpperCase(),
    status: d.status, admin: 1, comp: d.comp, bat: d.bat, charging: d.charging, net: d.net,
    rooted: d.rooted, enc: d.enc, lat: d.lat, lng: d.lng, seen: d.seen, enrolled: d.enrolled,
  });
  const id = info.lastInsertRowid;
  deviceIds.push(id);
  if (d.policy) db.prepare('INSERT OR REPLACE INTO device_policies (device_id, policy_id) VALUES (?, ?)').run(id, d.policy);
}

// Sample commands
const insCmd = db.prepare(`
  INSERT INTO commands (device_id, type, payload, status, result, issued_by, issued_at, sent_at, completed_at)
  VALUES (?, ?, '{}', ?, ?, ?, datetime('now', ?), datetime('now', ?), ?)
`);
insCmd.run(deviceIds[1], 'LOCK', 'completed', 'device locked', adminId, '-2 hours', '-2 hours', "datetime('now','-2 hours')");
insCmd.run(deviceIds[0], 'ENFORCE_POLICY', 'completed', 'applied: password[complex,>=8] camera=disabled', adminId, '-1 hours', '-1 hours', "datetime('now','-1 hours')");
insCmd.run(deviceIds[2], 'LOCATE', 'completed', 'location 31.5204,74.3587', adminId, '-30 minutes', '-30 minutes', "datetime('now','-30 minutes')");
insCmd.run(deviceIds[4], 'DISABLE', 'completed', 'device marked disabled', adminId, '-4 days', '-4 days', "datetime('now','-4 days')");
insCmd.run(deviceIds[3], 'PING', 'pending', null, adminId, '-5 seconds', null, null);

// Sample alerts
const insAlert = db.prepare(`INSERT INTO alerts (device_id, severity, type, message, acknowledged, created_at) VALUES (?, ?, ?, ?, ?, datetime('now', ?))`);
insAlert.run(deviceIds[2], 'critical', 'ROOT_DETECTED', '"Officer Khan Phone" reported as rooted/compromised', 0, '-15 seconds');
insAlert.run(deviceIds[2], 'warning', 'COMPLIANCE', '"Officer Khan Phone" non-compliant: Storage encryption is not enabled; Device appears to be rooted/compromised', 0, '-15 seconds');
insAlert.run(deviceIds[3], 'warning', 'COMPLIANCE', '"Recon Device 12" non-compliant: Battery critically low', 0, '-40 seconds');
insAlert.run(deviceIds[0], 'info', 'ENROLLMENT', 'Device "Field Unit Alpha" enrolled successfully', 1, '-6 days');

// Sample audit trail
const insAudit = db.prepare(`INSERT INTO audit_logs (actor_type, actor_id, actor_label, action, target_type, target_id, details, ip, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, datetime('now', ?))`);
insAudit.run('user', adminId, 'admin', 'LOGIN', null, null, null, '127.0.0.1', '-3 hours');
insAudit.run('user', adminId, 'admin', 'COMMAND_LOCK', 'device', String(deviceIds[1]), '{"device":"HQ Tablet 04"}', '127.0.0.1', '-2 hours');
insAudit.run('device', deviceIds[1], 'HQ Tablet 04', 'COMMAND_RESULT_LOCK', 'command', '1', '{"status":"completed"}', '10.0.2.16', '-2 hours');
insAudit.run('user', adminId, 'admin', 'ASSIGN_POLICY', 'device', String(deviceIds[0]), '{"policy_id":2}', '127.0.0.1', '-1 hours');
insAudit.run('device', deviceIds[2], 'Officer Khan Phone', 'DEVICE_ENROLLED', 'device', String(deviceIds[2]), '{"model":"Pixel 6"}', '10.0.2.16', '-3 days');

// eslint-disable-next-line no-console
console.log(`Demo data seeded: ${deviceIds.length} devices, sample commands, alerts and audit logs.`);
