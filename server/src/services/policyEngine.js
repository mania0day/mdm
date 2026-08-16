import { db } from '../db.js';

const getAssignedPolicy = db.prepare(`
  SELECT p.* FROM policies p
  JOIN device_policies dp ON dp.policy_id = p.id
  WHERE dp.device_id = ?
  ORDER BY dp.assigned_at DESC
  LIMIT 1
`);

const getDefaultPolicy = db.prepare(`SELECT * FROM policies WHERE is_default = 1 LIMIT 1`);

/**
 * Default policy schema. The Android agent maps these keys onto
 * DevicePolicyManager restrictions. (Proposal 5.3 Policy Enforcement)
 */
export const POLICY_SCHEMA = {
  min_password_length: 6,
  require_password: true,
  password_quality: 'numeric', // none | numeric | alphanumeric | complex
  max_failed_passwords: 10, // wipe after N failed unlocks (0 = disabled)
  max_screen_timeout_seconds: 300,
  disable_camera: false,
  disable_mic: false,
  require_encryption: true,
  block_rooted: true,
  // Force device location services ON and prevent the user from turning them
  // off (Device Owner), so live tracking is always available.
  force_location_on: true,
  // Keep airplane mode OFF and block the user from switching it on (Device
  // Owner), so a managed device can't be taken off the network on purpose.
  force_airplane_mode_off: true,
  // Availability lockdown (Device Owner). Block the OS routes normally used to
  // take a managed device off management or offline. Android has no API to stop
  // a hardware power-off, so these cover what CAN actually be enforced:
  //  - disallow_safe_boot: no Safe-Mode reboot (Safe Mode disables the admin).
  //  - disallow_factory_reset: no factory reset from Settings.
  //  - disallow_add_user: no secondary/guest user that lives outside the profile.
  // Enforced continuously (re-asserted every check-in) and honestly reported as
  // "requires Device Owner" on a device that is only a Device Admin.
  disallow_safe_boot: true,
  disallow_factory_reset: true,
  disallow_add_user: true,
};

/**
 * Resolve the effective policy for a device: its explicit assignment,
 * else the default policy, else the built-in schema.
 */
export function effectivePolicyForDevice(deviceId) {
  const row = getAssignedPolicy.get(deviceId) || getDefaultPolicy.get();
  if (!row) {
    return { id: null, name: 'built-in-default', config: { ...POLICY_SCHEMA } };
  }
  let cfg = {};
  try {
    cfg = JSON.parse(row.config || '{}');
  } catch {
    cfg = {};
  }
  return { id: row.id, name: row.name, config: { ...POLICY_SCHEMA, ...cfg } };
}

/**
 * Evaluate a device's reported state against its effective policy and
 * return a compliance verdict plus the list of violations.
 */
export function evaluateCompliance(device, reported = {}) {
  const { config: policy } = effectivePolicyForDevice(device.id);
  const violations = [];

  if (policy.require_encryption && reported.encryption_on === false) {
    violations.push('Storage encryption is not enabled');
  }
  if (policy.block_rooted && reported.is_rooted === true) {
    violations.push('Device appears to be rooted/compromised');
  }
  if (
    policy.require_password &&
    reported.password_set === false
  ) {
    violations.push('No screen-lock password is set');
  }
  if (
    typeof reported.battery_level === 'number' &&
    reported.battery_level <= 15 &&
    reported.battery_charging === false
  ) {
    violations.push('Battery critically low');
  }

  return {
    compliant: violations.length === 0,
    status: violations.length === 0 ? 'compliant' : 'non_compliant',
    violations,
    policy,
  };
}
