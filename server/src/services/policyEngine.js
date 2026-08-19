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

  // --- Corporate controls (block-or-watch) ---------------------------------
  // Each of these pairs with an entry in RULE_MODES below, which decides whether
  // the device physically BLOCKS the behaviour or merely reports it.
  //
  // block_outgoing_calls: company phone, company rules — stop personal//unbilled
  //   calls. Enforced with DISALLOW_OUTGOING_CALLS (Device Owner).
  // wifi_ssid_allowlist: the corporate networks a device may join. Anything else
  //   is "free wifi" — a captive-portal/hotel/coffee-shop network is a classic
  //   exfiltration and MITM risk. Hard enforcement needs Android 13+
  //   (setWifiSsidPolicy); below that the agent can only observe and report,
  //   which is precisely why monitor mode exists.
  // block_new_app_installs / block_unknown_sources: nothing gets installed that
  //   IT did not approve.
  // disallow_usb_transfer / disallow_debugging / disable_screen_capture: the
  //   standard data-loss-prevention trio (mass storage, ADB, screenshots).
  block_outgoing_calls: false,
  wifi_ssid_allowlist: [], // e.g. ["CorpWiFi","CorpWiFi-5G"]; empty = unrestricted
  block_new_app_installs: false,
  block_unknown_sources: true,
  disallow_usb_transfer: false,
  disallow_debugging: false,
  disable_screen_capture: false,

  // --- Kiosk / lock-task (OPT-IN, never part of a general phone policy) -----
  // Off by default and deliberately absent from the seeded base policy: turning
  // this on pins the device to the listed apps and takes away the launcher, so
  // it suits a dedicated single-purpose handset (POS, scanner, signage) and
  // would cripple an ordinary employee phone. Only a policy that explicitly sets
  // kiosk_mode true gets it.
  //
  // It is also the ONLY supported way to suppress the power menu: lock-task mode
  // hides the global-actions dialog unless LOCK_TASK_FEATURE_GLOBAL_ACTIONS is
  // requested. Even then a long-press still forces a firmware-level shutdown, so
  // this reduces casual power-offs rather than preventing them.
  kiosk_mode: false,
  kiosk_packages: [], // packages allowed in lock-task; agent is always included
  kiosk_allow_power_menu: false, // false = suppress the power/global-actions dialog

  // --- Per-rule enforcement mode -------------------------------------------
  // The core of the design: every controllable rule is either
  //   'enforce' - the device physically prevents it (default, block-first), or
  //   'monitor' - the device allows it but reports each breach as a violation,
  //               which raises an alert and lands in the device's Violations
  //               tab, or
  //   'off'     - the rule is not applied and not watched.
  // Monitor mode is not a lesser enforce: it is how you learn what people
  // actually do before you clamp down, and it is the ONLY option for rules the
  // handset is too old to enforce (see wifi_ssid_allowlist above) — a device
  // that cannot block is still perfectly capable of reporting.
  rule_modes: {
    disable_camera: 'enforce',
    disable_mic: 'enforce',
    block_outgoing_calls: 'enforce',
    wifi_ssid_allowlist: 'monitor',
    force_airplane_mode_off: 'enforce',
    block_new_app_installs: 'enforce',
    block_unknown_sources: 'enforce',
    disallow_usb_transfer: 'enforce',
    disallow_debugging: 'enforce',
    disable_screen_capture: 'enforce',
  },
};

/** Valid values for any entry in rule_modes. */
export const RULE_MODES = ['enforce', 'monitor', 'off'];

/**
 * The mode a single rule runs in, falling back to the schema default (and
 * finally to 'enforce') so a policy saved before rule_modes existed keeps
 * behaving exactly as it did — block-first.
 */
export function ruleMode(policy, rule) {
  const mode = policy?.rule_modes?.[rule] ?? POLICY_SCHEMA.rule_modes[rule];
  return RULE_MODES.includes(mode) ? mode : 'enforce';
}

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
  return {
    id: row.id,
    name: row.name,
    // rule_modes is merged one level deeper than the rest: a spread alone would
    // let a policy that names a single rule's mode silently drop the defaults
    // for every other rule, turning unmentioned rules into undefined (i.e. no
    // enforcement) rather than leaving them at their block-first default.
    config: {
      ...POLICY_SCHEMA,
      ...cfg,
      rule_modes: { ...POLICY_SCHEMA.rule_modes, ...(cfg.rule_modes || {}) },
    },
  };
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
