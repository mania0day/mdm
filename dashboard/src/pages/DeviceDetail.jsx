import { useEffect, useState, useCallback, useRef } from 'react';
import { useParams, useNavigate, Link } from 'react-router-dom';
import { motion } from 'framer-motion';
import { ResponsiveContainer, BarChart, Bar, XAxis, YAxis, Tooltip, Cell } from 'recharts';
import { api } from '../api';
import { useAuth, hasRole } from '../auth.jsx';
import { Spinner, StatusBadge, ComplianceBadge, OnlineDot, SeverityBadge, timeAgo, EmptyState, notifyAlertsChanged } from '../ui.jsx';
import LocationMap from '../components/LocationMap.jsx';

// Spaced well apart in hue (not all clustered in red-orange) so the three
// tiers read as distinct at a glance, not as one blurry "bad" color.
const CVE_SEVERITY_COLORS = { Critical: '#dc2626', High: '#f97316', Medium: '#ca8a04' };
const CVE_LEVEL_TEXT = {
  CRITICAL: 'text-red-700 dark:text-red-400',
  HIGH: 'text-orange-700 dark:text-orange-400',
  MEDIUM: 'text-amber-700 dark:text-amber-400',
  LOW: 'text-slate-600 dark:text-slate-300',
  NONE: 'text-accent-700 dark:text-accent-400',
};

// Remote commands surfaced as buttons, grouped by intent. (UNLOCK is
// intentionally omitted: a device admin cannot clear an existing lock-screen
// password on modern Android, so the agent could only ever acknowledge it —
// a button that can't do what it says is worse than no button.)
const COMMAND_GROUPS = [
  {
    label: 'Monitor',
    commands: [
      { type: 'PING', label: 'Ping', role: 'operator', confirm: false },
      { type: 'LOCATE', label: 'Locate', role: 'operator', confirm: false },
    ],
  },
  {
    label: 'Control',
    commands: [
      { type: 'LOCK', label: 'Lock', role: 'operator', confirm: false },
      { type: 'RING', label: 'Ring', role: 'operator', confirm: false },
      // Reboot is the only remote power control Android exposes (there is no
      // power-off API). Device Owner only; confirmed because it interrupts the
      // user, and the agent defers it if a call is in progress.
      { type: 'RESTART', label: 'Restart', role: 'admin', confirm: true },
      { type: 'ENFORCE_POLICY', label: 'Re-enforce Policy', role: 'admin', confirm: false },
      { type: 'ENABLE', label: 'Re-enable', role: 'admin', confirm: false },
    ],
  },
  {
    // Radio/sensor toggles. These require Device Owner provisioning on the
    // handset — on a plain Device Admin the agent reports back that it could
    // not apply them rather than silently doing nothing.
    label: 'Device Settings',
    commands: [
      { type: 'LOCATION_ON', label: 'Location On', role: 'admin', confirm: false },
      { type: 'LOCATION_OFF', label: 'Location Off', role: 'admin', confirm: false },
      { type: 'AIRPLANE_MODE_OFF', label: 'Disable Airplane Mode', role: 'admin', confirm: false },
      { type: 'AIRPLANE_MODE_ALLOW', label: 'Allow Airplane Mode', role: 'admin', confirm: false },
    ],
  },
  {
    label: 'Destructive',
    commands: [
      { type: 'DISABLE', label: 'Disable Device', role: 'admin', confirm: true, variant: 'danger' },
      { type: 'REMOTE_UNINSTALL', label: 'Remove App', role: 'admin', confirm: true, variant: 'danger' },
      { type: 'WIPE', label: 'Factory Wipe', role: 'admin', confirm: true, variant: 'danger' },
    ],
  },
];

// These policy fields require Device Owner provisioning to actually be
// enforced via DevicePolicyManager — on a plain Device Admin, Android
// throws SecurityException for all of them (confirmed by the agent's own
// ENFORCE_POLICY result string). Only max_failed_passwords and
// max_screen_timeout_seconds work at the Device Admin level.
//
// This set must stay in sync with POLICY_SCHEMA in
// server/src/services/policyEngine.js. The banner above the list tells the
// operator that the items marked "owner only" are the ones NOT applied, so a
// missing key is not a missing label — it is an affirmative claim that a Device
// Admin handset is enforcing that rule. Add every new owner-gated key here at
// the same time it is added to the schema.
// (require_encryption and block_rooted are deliberately absent: they are
// server-side compliance checks the agent never pushes to the handset at any
// provisioning level, so "owner only" would be the wrong caveat for them.)
const OWNER_ONLY_POLICY_KEYS = new Set([
  'min_password_length',
  'require_password',
  'password_quality',
  'disable_camera',
  'disable_mic',
  'force_location_on',
  'force_airplane_mode_off',
  // Availability lockdown — all addUserRestriction(), Device Owner only.
  'disallow_safe_boot',
  'disallow_factory_reset',
  'disallow_add_user',
  // Corporate controls — user restrictions, setScreenCaptureDisabled() and
  // setWifiSsidPolicy(); every one throws for a plain Device Admin.
  'block_outgoing_calls',
  'wifi_ssid_allowlist',
  'block_new_app_installs',
  'block_unknown_sources',
  'disallow_usb_transfer',
  'disallow_debugging',
  'disable_screen_capture',
  // Kiosk / lock-task — setLockTaskPackages() and setLockTaskFeatures().
  'kiosk_mode',
  'kiosk_packages',
  'kiosk_allow_power_menu',
]);

// Human-readable names for the rules the agent can report a breach of. The raw
// snake_case key is what the policy engine and the handset speak; an operator
// scanning this list should not have to. Anything missing here (a rule added
// server-side that this map has not caught up with) falls back to the
// de-underscored key rather than being hidden.
const VIOLATION_RULE_LABELS = {
  block_outgoing_calls: 'Outgoing calls',
  wifi_ssid_allowlist: 'Wi-Fi network allowlist',
  block_new_app_installs: 'App installs',
  block_unknown_sources: 'Unknown-source installs',
  disallow_usb_transfer: 'USB file transfer',
  disallow_debugging: 'USB / ADB debugging',
  disable_screen_capture: 'Screen capture',
  disable_camera: 'Camera',
  disable_mic: 'Microphone',
  force_airplane_mode_off: 'Airplane mode',
  kiosk_mode: 'Kiosk lock-task',
};

// How each mode reads to an operator — the distinction is the entire point of
// this list, so it lives in the label and the sentence under it, never in the
// colour alone:
//  - 'monitor' is the system working as designed. The handset deliberately did
//    NOT block the action; this row is the only trace the breach ever left.
//  - 'enforce' is a stronger signal. The rule was meant to be blocked and the
//    device reported it instead, which means the API was not available to it
//    (most of these are Android-version gated — Wi-Fi SSID allowlisting needs
//    13+, for example). The control is not actually in place on that handset.
const VIOLATION_MODES = {
  monitor: {
    label: 'Monitored',
    badge: 'bg-brand-100 text-brand-700 ring-1 ring-brand-600/20 dark:bg-brand-500/15 dark:text-brand-300 dark:ring-brand-400/25',
    note: 'Allowed by design — the device reported it instead of blocking it.',
  },
  enforce: {
    label: 'Not blocked',
    badge: 'bg-orange-100 text-orange-700 ring-1 ring-orange-600/20 dark:bg-orange-500/15 dark:text-orange-300 dark:ring-orange-400/25',
    note: 'Set to enforce, but this handset could not block it — the control is not in place here.',
  },
  off: {
    label: 'Rule off',
    badge: 'bg-slate-100 text-slate-600 ring-1 ring-slate-400/20 dark:bg-slate-700/50 dark:text-slate-300 dark:ring-slate-500/25',
    note: 'The rule was switched off at the time — kept for the record only.',
  },
};

// Friendlier names for the metadata the agent attaches to a breach. The payload
// is free-form JSON, so unknown keys are still rendered (de-underscored) — an
// unrecognised field is evidence too and must not be swallowed.
const VIOLATION_METADATA_LABELS = {
  ssid: 'SSID',
  bssid: 'BSSID',
  package: 'Package',
  package_name: 'Package',
  app_label: 'App',
  number: 'Number',
  phone_number: 'Number',
  api_level: 'API level',
  required_api: 'Needs API',
  reason: 'Reason',
  count: 'Count',
};

// The Alerts card above shows the 8 most recent; violations follow suit rather
// than dumping the server's 200-row cap on the page by default.
const VIOLATION_PREVIEW_COUNT = 8;

function violationRuleLabel(rule) {
  return VIOLATION_RULE_LABELS[rule] || String(rule || 'unknown rule').replace(/_/g, ' ');
}

function violationMetaLabel(key) {
  return VIOLATION_METADATA_LABELS[key] || key.replace(/_/g, ' ');
}

function violationMetaValue(value) {
  if (value === null || value === undefined || value === '') return '—';
  if (Array.isArray(value)) return value.join(', ');
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
}

/**
 * When a violation actually happened. occurred_at is the device's own clock at
 * the moment of the breach and is what we want: a phone that was offline for an
 * hour uploads late, and dating the row by the upload would misreport it. Falls
 * back to the server's receipt time — parsed the same way timeAgo() does, since
 * SQLite hands back "YYYY-MM-DD HH:MM:SS" (UTC, no zone marker) while the agent
 * sends ISO.
 *
 * The fallback covers an occurred_at that is present but UNPARSEABLE, not just a
 * missing one: the field is agent-supplied and the server only length-checks it,
 * so a device clock formatted any other way ("2026-08-19 14:03:11 UTC", epoch
 * millis) yields an Invalid Date. Treating that as "no timestamp at all" would
 * both label the row "time unknown" and sort it to the bottom — pushing the
 * newest evidence out of the preview — while a perfectly good server timestamp
 * sat unused. Returns the source too, so the row can never caption a fallback
 * as the device's own clock.
 */
function violationDate(v) {
  for (const [source, ts] of [['device', v.occurred_at], ['server', v.created_at]]) {
    if (typeof ts !== 'string' || !ts) continue;
    const date = new Date(ts.includes('T') ? ts : ts + 'Z');
    if (!Number.isNaN(date.getTime())) return { date, ts, source };
  }
  return null;
}

/**
 * A policy value as an operator should read it. String(v) covers the booleans
 * and numbers that make up most of the schema, but the list-valued keys
 * (wifi_ssid_allowlist, kiosk_packages) need help: an empty array stringifies to
 * an empty string, which on this card is indistinguishable from "not set" — and
 * for an allowlist those mean opposite things, so an empty one says so in words.
 */
function policyValueText(v) {
  if (Array.isArray(v)) return v.length ? v.join(', ') : 'none';
  if (v === null || v === undefined || v === '') return '—';
  return String(v);
}

// Staggered reveal for the main sections.
const container = {
  hidden: {},
  show: { transition: { staggerChildren: 0.06 } },
};
const item = {
  hidden: { opacity: 0, y: 16 },
  show: { opacity: 1, y: 0, transition: { duration: 0.4, ease: 'easeOut' } },
};

function Info({ label, value, mono }) {
  return (
    <div>
      <div className="text-xs text-slate-500 dark:text-slate-400">{label}</div>
      <div className={`text-sm ${mono ? 'font-mono text-slate-700 dark:text-slate-200' : 'text-slate-800 dark:text-slate-100'}`}>
        {value ?? '—'}
      </div>
    </div>
  );
}

export default function DeviceDetail() {
  const { id } = useParams();
  const navigate = useNavigate();
  const { user } = useAuth();
  const [data, setData] = useState(null);
  const [policies, setPolicies] = useState([]);
  const [alerts, setAlerts] = useState(null);
  const [enrollmentHistory, setEnrollmentHistory] = useState(null);
  const [violations, setViolations] = useState(null);
  const [violationsError, setViolationsError] = useState('');
  const [showAllViolations, setShowAllViolations] = useState(false);
  const [busy, setBusy] = useState('');
  const [toast, setToast] = useState('');
  // The device this page is currently showing. React does NOT remount
  // DeviceDetail when only the :id param changes, so a violations request fired
  // for the previous device can still be in flight when the route moves on and
  // would otherwise resolve into the new device's card. This is evidence about
  // one specific handset, so the id is re-checked at resolution time.
  const shownDeviceId = useRef(id);

  const load = useCallback(() => {
    api.get(`/devices/${id}`).then(setData).catch(() => navigate('/devices'));
    api.get(`/alerts?device_id=${id}`).then((d) => setAlerts(d.alerts)).catch(() => {});
    // Policy breaches this device reported. Rides the same 6s poll as the rest
    // of the page — a monitored rule is never blocked on the handset, so a new
    // row here is the first and only sign the operator gets that it happened.
    // The failure is kept rather than swallowed: on this card an empty list is
    // itself a claim ("nothing happened"), so a dead endpoint must not be
    // allowed to look like one.
    api
      .get(`/devices/${id}/violations`)
      .then((d) => {
        if (shownDeviceId.current !== id) return;
        setViolations(d.violations);
        setViolationsError('');
      })
      .catch((e) => {
        if (shownDeviceId.current !== id) return;
        setViolationsError(e.message || 'request failed');
      });
    // Enroll/unenroll/re-enroll timeline — device stays on record through all
    // of these (unenroll is soft), so this always has the full story.
    api
      .get(`/audit-logs?device_id=${id}`)
      .then((d) => setEnrollmentHistory(d.logs.filter((l) => l.action.includes('ENROLL'))))
      .catch(() => {});
  }, [id, navigate]);

  useEffect(() => {
    load();
    api.get('/policies').then((d) => setPolicies(d.policies)).catch(() => {});
    const t = setInterval(load, 6000);
    return () => clearInterval(t);
  }, [load]);

  // Opening a device counts as "seen" — ack its open alerts once so the badge
  // on the devices list drops to 0, without re-acking on every 6s poll above.
  useEffect(() => {
    api.post(`/alerts/ack-all?device_id=${id}`).then(notifyAlertsChanged).catch(() => {});
  }, [id]);

  // Drop the previous device's violations the moment the route changes. This
  // list is evidence about one specific handset — showing device A's breaches
  // under device B's name for the fraction of a second before the new fetch
  // lands would be worse than showing the loading state. Moving the ref here
  // (rather than the load effect) is what makes an already-in-flight response
  // for the old device get discarded instead of landing after this clear.
  useEffect(() => {
    shownDeviceId.current = id;
    setViolations(null);
    setViolationsError('');
    setShowAllViolations(false);
  }, [id]);

  if (!data) return <Spinner />;
  const { device, policy, commands, cve } = data;
  const cveChartData = cve
    ? [
        { name: 'Critical', value: cve.critical_count, color: CVE_SEVERITY_COLORS.Critical },
        { name: 'High', value: cve.high_count, color: CVE_SEVERITY_COLORS.High },
        { name: 'Medium', value: cve.medium_count, color: CVE_SEVERITY_COLORS.Medium },
      ]
    : [];

  // Newest first by the same timestamp the row displays (the device's own clock
  // where it sent one), so the ordering can never disagree with the labels next
  // to it; id descending breaks ties from a batched upload.
  const violationRows = violations
    ? [...violations].sort(
        (a, b) => (violationDate(b)?.date.getTime() || 0) - (violationDate(a)?.date.getTime() || 0) || b.id - a.id,
      )
    : null;
  const shownViolations = showAllViolations ? violationRows : violationRows?.slice(0, VIOLATION_PREVIEW_COUNT);
  // Breaches of a rule that was supposed to block — i.e. controls this handset
  // is not actually applying. Called out separately because it is the number
  // that warrants action, not the raw total.
  const unblockedCount = violationRows?.filter((v) => v.mode === 'enforce').length || 0;

  async function sendCommand(cmd) {
    if (cmd.confirm && !confirm(`Confirm "${cmd.label}" on ${device.name}? This is a sensitive action.`)) return;
    setBusy(cmd.type);
    try {
      await api.post(`/devices/${id}/commands`, { type: cmd.type });
      setToast(`Command ${cmd.type} queued — device will execute on next check-in.`);
      load();
    } catch (e) {
      setToast(`Error: ${e.message}`);
    } finally {
      setBusy('');
      setTimeout(() => setToast(''), 4000);
    }
  }

  async function assignPolicy(policyId) {
    try {
      await api.post(`/devices/${id}/policy`, { policy_id: policyId ? Number(policyId) : null });
      setToast('Policy assigned and pushed to device.');
      load();
      setTimeout(() => setToast(''), 4000);
    } catch (e) {
      setToast(`Error: ${e.message}`);
    }
  }

  async function deregister() {
    if (!confirm(`Unenroll ${device.name}? Its token is revoked immediately and it leaves management — its full history stays on record.`)) return;
    try {
      await api.del(`/devices/${id}`);
      setToast('Device unenrolled. Token revoked; history retained.');
      load();
    } catch (e) {
      setToast(`Unenroll failed: ${e.message}`);
    } finally {
      setTimeout(() => setToast(''), 5000);
    }
  }

  async function toggleReconfigure(allow) {
    try {
      await api.post(`/devices/${id}/reconfigure`, { allow });
      setToast(allow ? 'IT setup unlocked on the device.' : 'IT setup locked on the device.');
      load();
    } catch (e) {
      setToast(`Error: ${e.message}`);
    } finally {
      setTimeout(() => setToast(''), 4000);
    }
  }

  return (
    <div className="space-y-6">
      {toast && (
        <motion.div
          initial={{ opacity: 0, y: -12 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.3, ease: 'easeOut' }}
          className="fixed top-4 right-4 z-50 card px-4 py-3 text-sm text-white bg-brand-600 border-brand-700"
        >
          {toast}
        </motion.div>
      )}

      <div className="flex items-center gap-3 text-sm text-slate-500 dark:text-slate-400">
        <Link to="/devices" className="hover:text-brand-700 dark:hover:text-brand-300">Devices</Link>
        <span>/</span>
        <span className="text-slate-700 dark:text-slate-200">{device.name}</span>
      </div>

      <div className="flex items-start justify-between">
        <div>
          <div className="flex items-center gap-3">
            <h1 className="font-display text-2xl font-bold text-slate-900 dark:text-slate-100">{device.name}</h1>
            <StatusBadge status={device.status} />
            <ComplianceBadge value={device.compliance} />
          </div>
          <div className="mt-1 flex items-center gap-3 text-sm text-slate-500 dark:text-slate-400">
            <OnlineDot online={device.online} />
            <span>· last seen {timeAgo(device.last_seen)}</span>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <Link to={`/devices/${id}/report`} className="btn-ghost">
            Analysis Report
          </Link>
          {hasRole(user, 'admin') && device.status !== 'unenrolled' && (
            <button onClick={deregister} className="btn-danger">
              Unenroll Device
            </button>
          )}
        </div>
      </div>

      <motion.div variants={container} initial="hidden" animate="show" className="space-y-6">
        {/* Remote command bar (left) + live location map (right) */}
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-6 items-stretch">
          <motion.div variants={item} className="card p-5 lg:col-span-2">
            <h2 className="font-display font-semibold text-slate-900 dark:text-slate-100 mb-3">Remote Actions</h2>
            <div className="space-y-3">
              {COMMAND_GROUPS.map((g) => {
                const visible = g.commands.filter((c) => hasRole(user, c.role));
                if (!visible.length) return null;
                return (
                  <div key={g.label} className="flex items-center gap-3 flex-wrap">
                    <span className="text-xs font-semibold uppercase tracking-wider text-slate-400 dark:text-slate-500 w-20 shrink-0">
                      {g.label}
                    </span>
                    <div className="flex flex-wrap gap-2">
                      {visible.map((c) => (
                        <button
                          key={c.type}
                          onClick={() => sendCommand(c)}
                          disabled={busy === c.type}
                          className={c.variant === 'danger' ? 'btn-danger' : 'btn-ghost'}
                        >
                          {busy === c.type ? '…' : c.label}
                        </button>
                      ))}
                    </div>
                  </div>
                );
              })}
            </div>
            <p className="text-xs text-slate-400 dark:text-slate-500 mt-3">
              Commands are queued securely and executed by the agent on its next check-in
              (~10s). Destructive actions require an admin role.
            </p>
          </motion.div>

          {/* Live location — populated by the Locate command / periodic check-ins */}
          <motion.div variants={item} className="card p-0 overflow-hidden flex flex-col">
            <div className="px-5 py-3.5 border-b border-slate-100 dark:border-slate-800 flex items-center justify-between">
              <h2 className="font-display font-semibold text-slate-900 dark:text-slate-100">Location</h2>
              <span className="text-xs text-slate-400 dark:text-slate-500">
                {device.latitude != null ? `updated ${timeAgo(device.last_seen)}` : 'awaiting fix'}
              </span>
            </div>
            <div className="flex-1">
              <LocationMap latitude={device.latitude} longitude={device.longitude} />
            </div>
          </motion.div>
        </div>

        {hasRole(user, 'admin') && (
          <motion.div variants={item} className="card p-5 flex items-center justify-between gap-4">
            <div>
              <h2 className="font-semibold text-slate-900 dark:text-slate-100">On-Device IT Setup</h2>
              <p className="text-xs text-slate-500 dark:text-slate-400 mt-0.5">
                The technical setup screen (server URL, technical details) is hidden on the device by default —
                the employee only ever sees their name and status. Turn this on only while a technician needs it,
                then turn it back off.
              </p>
            </div>
            <button
              onClick={() => toggleReconfigure(!device.allow_reconfigure)}
              className={device.allow_reconfigure ? 'btn-accent shrink-0' : 'btn-ghost shrink-0'}
            >
              {device.allow_reconfigure ? 'Unlocked — tap to lock' : 'Locked — tap to unlock'}
            </button>
          </motion.div>
        )}

        <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
          {/* Device info */}
          <motion.div variants={item} className="card p-5 lg:col-span-2">
            <h2 className="font-display font-semibold text-slate-900 dark:text-slate-100 mb-4">Device Information</h2>
            <div className="grid grid-cols-2 md:grid-cols-3 gap-4">
              <Info label="Manufacturer" value={device.manufacturer} />
              <Info label="Model" value={device.model} />
              <Info label="Android" value={device.os_version ? `${device.os_version} (API ${device.sdk_int || '?'})` : null} />
              <Info label="Owner" value={device.owner_name} />
              <Info label="Employee ID" value={device.employee_id} />
              <Info label="Department" value={device.department} />
              <Info label="Serial" value={device.serial} mono />
              <Info label="Device UID" value={device.device_uid} mono />
              <Info
                label="Management"
                value={
                  device.management_mode === 'device_owner'
                    ? 'Device Owner (full control)'
                    : device.management_mode === 'device_admin'
                      ? 'Device Admin (basic control)'
                      : 'None'
                }
              />
              <Info label="Encryption" value={device.encryption_on ? 'On' : 'Off/Unknown'} />
              <Info label="Rooted" value={device.is_rooted ? '⚠ Yes' : 'No'} />
              <Info label="Battery" value={device.battery_level != null ? `${device.battery_level}%${device.battery_charging ? ' ⚡' : ''}` : null} />
              <Info label="Network" value={device.network_type} />
              <Info label="IMEI" value={device.imei || (device.management_mode === 'device_owner' ? '—' : 'unavailable (needs Device Owner)')} mono />
              <Info label="Phone Number" value={device.phone_number || '— (not reported by carrier)'} mono />
              <Info label="SIM Operator" value={device.sim_operator} />
              <Info label="Security Patch" value={device.security_patch} />
              <Info label="Build Fingerprint" value={device.build_fingerprint} mono />
              <Info label="🦖 Runner High Score" value={device.high_score ? device.high_score.toLocaleString() : '—'} />
              <div>
                <div className="text-xs text-slate-500 dark:text-slate-400">Location</div>
                {device.latitude != null ? (
                  <a
                    href={`https://www.google.com/maps/search/?api=1&query=${device.latitude},${device.longitude}`}
                    target="_blank"
                    rel="noreferrer"
                    className="text-sm text-brand-700 dark:text-brand-300 hover:text-brand-800 dark:hover:text-slate-100 inline-flex flex-col leading-tight"
                    title="Open live location in Google Maps"
                  >
                    <span className="font-mono">{device.latitude.toFixed(5)}, {device.longitude.toFixed(5)}</span>
                    <span className="text-xs text-brand-700 dark:text-brand-300 hover:text-brand-800 dark:hover:text-slate-100 inline-flex items-center gap-1">
                      View live on Google Maps
                      <svg viewBox="0 0 24 24" className="h-3 w-3" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                        <path d="M18 13v6a2 2 0 01-2 2H5a2 2 0 01-2-2V8a2 2 0 012-2h6M15 3h6v6M10 14L21 3" />
                      </svg>
                    </span>
                  </a>
                ) : (
                  <div className="text-sm text-slate-800 dark:text-slate-100">—</div>
                )}
              </div>
              <Info label="Enrolled" value={timeAgo(device.enrolled_at)} />
            </div>
          </motion.div>

          {/* Policy */}
          <motion.div variants={item} className="card p-5">
            <h2 className="font-display font-semibold text-slate-900 dark:text-slate-100 mb-4">Assigned Policy</h2>
            <div className="text-brand-700 dark:text-brand-300 font-medium mb-1">{policy.name}</div>
            {hasRole(user, 'admin') && (
              <select
                className="input mb-4"
                value={policy.id || ''}
                onChange={(e) => assignPolicy(e.target.value)}
              >
                <option value="">— none (built-in default) —</option>
                {policies.map((p) => (
                  <option key={p.id} value={p.id}>{p.name}</option>
                ))}
              </select>
            )}
            {device.management_mode !== 'device_owner' && (
              <p className="text-xs text-amber-700 dark:text-amber-400 bg-amber-50 dark:bg-amber-500/10 border border-amber-200 dark:border-amber-500/20 rounded-lg px-3 py-2 mb-3">
                This device is <strong>Device Admin</strong>, not Device Owner. Android only lets a small subset of
                policy actually be enforced at that level — items marked <em>Owner only</em> below are monitored for
                compliance but not applied on this device. Full enforcement needs the QR zero-touch (Device Owner)
                provisioning flow.
              </p>
            )}
            <dl className="space-y-1.5 text-sm">
              {Object.entries(policy.config).map(([k, v]) =>
                // rule_modes gets its own block rather than a one-line value:
                // it is a map, so the shared value cell would render it as
                // "[object Object]" — and enforce/monitor/off per rule is the
                // single most consequential thing on this card, since it is what
                // decides whether the handset blocks a breach or merely reports
                // one into the Violations list below.
                k === 'rule_modes' && v && typeof v === 'object' && !Array.isArray(v) ? (
                  <div key={k}>
                    <dt className="text-slate-500 dark:text-slate-400">rule modes</dt>
                    <dd className="mt-1">
                      <ul className="space-y-1 border-l-2 border-slate-100 dark:border-slate-800 pl-3">
                        {Object.entries(v).map(([rule, ruleMode]) => (
                          <li key={rule} className="flex justify-between items-center gap-2">
                            <span className="text-slate-500 dark:text-slate-400 flex items-center gap-1.5">
                              {violationRuleLabel(rule)}
                              {/* Same caveat the flat rows carry. Every rule in
                                  rule_modes is Device-Owner-only, so on a Device
                                  Admin handset an unmarked "enforce" would read
                                  as a control that is in force when none of them
                                  are — the omission itself makes a claim. */}
                              {device.management_mode !== 'device_owner' && OWNER_ONLY_POLICY_KEYS.has(rule) && (
                                <span className="text-[10px] uppercase tracking-wide text-amber-600 dark:text-amber-400 font-semibold">
                                  owner only
                                </span>
                              )}
                            </span>
                            <span className="text-slate-700 dark:text-slate-200 font-mono">
                              {policyValueText(ruleMode)}
                            </span>
                          </li>
                        ))}
                      </ul>
                    </dd>
                  </div>
                ) : (
                  <div key={k} className="flex justify-between items-center gap-2">
                    <dt className="text-slate-500 dark:text-slate-400 flex items-center gap-1.5">
                      {k.replace(/_/g, ' ')}
                      {device.management_mode !== 'device_owner' && OWNER_ONLY_POLICY_KEYS.has(k) && (
                        <span className="text-[10px] uppercase tracking-wide text-amber-600 dark:text-amber-400 font-semibold">
                          owner only
                        </span>
                      )}
                    </dt>
                    <dd className="text-slate-700 dark:text-slate-200 font-mono">{policyValueText(v)}</dd>
                  </div>
                ),
              )}
            </dl>
          </motion.div>
        </div>

        {/* Policy violations — what this device actually DID against its policy.
            Separate from Alerts on purpose: an alert is a notification that gets
            acknowledged and cleared, this is the durable record of the breach. */}
        <motion.div variants={item} className="card">
          <div className="px-5 py-4 border-b border-slate-100 dark:border-slate-800">
            <div className="flex items-center justify-between flex-wrap gap-2">
              <h2 className="font-display font-semibold text-slate-900 dark:text-slate-100">Policy Violations</h2>
              {violationRows?.length > 0 && (
                <span className="text-xs text-slate-500 dark:text-slate-400">
                  {violationRows.length} recorded · {unblockedCount} not blocked
                </span>
              )}
            </div>
            <p className="text-xs text-slate-500 dark:text-slate-400 mt-1.5 max-w-3xl">
              A <strong className="font-semibold text-slate-700 dark:text-slate-200">monitored</strong> rule is
              deliberately not blocked on the handset — the device allows the action and reports it, so these rows are
              the only record it ever happened. A rule marked{' '}
              <strong className="font-semibold text-slate-700 dark:text-slate-200">not blocked</strong> is set to
              enforce but the device could not apply it (usually an API its Android version does not have): that
              control is not in place on this handset and needs attention.
            </p>
          </div>
          {/* A failed fetch must never read as "no breaches". The empty state
              below is a positive statement about this handset's behaviour, so
              when the list could not be read at all we say that instead — in
              words, not by leaving a spinner turning forever. */}
          {violationsError && (
            <p
              role="alert"
              className="px-5 py-3 text-xs text-amber-700 dark:text-amber-400 bg-amber-50 dark:bg-amber-500/10 border-b border-amber-200 dark:border-amber-500/20"
            >
              <strong className="font-semibold">Could not load violations</strong> — {violationsError}. This is a
              failure to read the record, not a statement that there are none
              {/* Keyed on whether a poll ever succeeded, not on the row count.
                  With a successful-but-empty poll behind it, the old check
                  dropped this clause and left the disclaimer sitting directly
                  above "No policy violations recorded" — the two read as a
                  contradiction, when in fact the empty result was real. */}
              {violationRows
                ? violationRows.length
                  ? '; the rows below are from the last successful poll'
                  : '; the last successful poll found none'
                : ''}
              .
            </p>
          )}
          {!violationRows ? (
            violationsError ? null : <Spinner />
          ) : violationRows.length ? (
            <>
              <ol className="divide-y divide-slate-100 dark:divide-slate-800">
                {shownViolations.map((v) => {
                  const mode = VIOLATION_MODES[v.mode] || {
                    ...VIOLATION_MODES.off,
                    label: v.mode ? String(v.mode) : 'unknown mode',
                    note: 'The agent reported a mode this console does not recognise.',
                  };
                  const when = violationDate(v);
                  return (
                    <li key={v.id} className="px-5 py-3.5 flex items-start gap-3">
                      <SeverityBadge severity={v.severity} />
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2 flex-wrap">
                          <span className="text-sm font-medium text-slate-800 dark:text-slate-100">
                            {violationRuleLabel(v.rule)}
                          </span>
                          <span className={`badge ${mode.badge}`}>{mode.label}</span>
                        </div>
                        <p className="text-sm text-slate-700 dark:text-slate-200 mt-0.5">
                          {v.detail || `${violationRuleLabel(v.rule)} breached`}
                        </p>
                        <p className="text-xs text-slate-500 dark:text-slate-400 mt-0.5">{mode.note}</p>
                        {v.metadata && Object.keys(v.metadata).length > 0 && (
                          <dl className="mt-1.5 flex flex-wrap gap-1.5">
                            {Object.entries(v.metadata).map(([k, val]) => (
                              <div
                                key={k}
                                className="inline-flex items-baseline gap-1.5 rounded-md border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-800/60 px-2 py-0.5"
                              >
                                <dt className="text-[11px] uppercase tracking-wide text-slate-500 dark:text-slate-400">
                                  {violationMetaLabel(k)}
                                </dt>
                                <dd className="text-xs font-mono text-slate-700 dark:text-slate-200 break-all">
                                  {violationMetaValue(val)}
                                </dd>
                              </div>
                            ))}
                          </dl>
                        )}
                      </div>
                      {when ? (
                        <time
                          dateTime={when.date.toISOString()}
                          title={`${when.source === 'device' ? 'Device clock' : 'Recorded by server'}: ${when.date.toLocaleString()}`}
                          className="text-xs text-slate-500 dark:text-slate-400 whitespace-nowrap shrink-0"
                        >
                          {timeAgo(when.ts)}
                        </time>
                      ) : (
                        <span className="text-xs text-slate-500 dark:text-slate-400 whitespace-nowrap shrink-0">
                          time unknown
                        </span>
                      )}
                    </li>
                  );
                })}
              </ol>
              {violationRows.length > VIOLATION_PREVIEW_COUNT && (
                <div className="px-5 py-3 border-t border-slate-100 dark:border-slate-800">
                  <button
                    onClick={() => setShowAllViolations((s) => !s)}
                    className="text-xs text-brand-700 dark:text-brand-300 hover:text-brand-800"
                  >
                    {showAllViolations
                      ? `Show only the latest ${VIOLATION_PREVIEW_COUNT}`
                      : `Show all ${violationRows.length} violations →`}
                  </button>
                </div>
              )}
            </>
          ) : (
            <EmptyState>No policy violations recorded</EmptyState>
          )}
        </motion.div>

        {/* CVE exposure — high/critical unpatched vulnerability graph for this device */}
        {cve && (
          <motion.div variants={item} className="card p-5">
            <div className="flex items-center justify-between flex-wrap gap-2 mb-1">
              <h2 className="font-display font-semibold text-slate-900 dark:text-slate-100">CVE Exposure</h2>
              <span className={`text-sm font-bold ${CVE_LEVEL_TEXT[cve.overall_level] || 'text-slate-500'}`}>
                {cve.overall_level}
              </span>
            </div>
            <p className="text-xs text-slate-500 dark:text-slate-400 mb-4">
              {cve.os_eol
                ? cve.os_eol_details
                : `${cve.total_unpatched} unpatched CVE(s) against security patch ${cve.security_patch || '—'}`}
            </p>
            {cveChartData.some((d) => d.value > 0) ? (
              <ResponsiveContainer width="100%" height={140}>
                <BarChart data={cveChartData} layout="vertical" margin={{ left: 8 }}>
                  <XAxis type="number" allowDecimals={false} tick={{ fontSize: 12, fill: '#94a3b8' }} />
                  <YAxis type="category" dataKey="name" width={64} tick={{ fontSize: 12, fill: '#94a3b8' }} />
                  <Tooltip contentStyle={{ background: '#1e293b', border: '1px solid #334155', borderRadius: 8, fontSize: 12, color: '#e2e8f0' }} />
                  <Bar dataKey="value" radius={[0, 6, 6, 0]}>
                    {cveChartData.map((d) => <Cell key={d.name} fill={d.color} />)}
                  </Bar>
                </BarChart>
              </ResponsiveContainer>
            ) : (
              <div className="text-slate-400 dark:text-slate-500 text-sm py-6 text-center">No known unpatched CVEs</div>
            )}
            <Link to={`/devices/${id}/report`} className="text-xs text-brand-700 dark:text-brand-300 hover:text-brand-800 mt-2 inline-block">
              Full CVE list in Analysis Report →
            </Link>
          </motion.div>
        )}

        {/* Enrollment history — this device record is never deleted, so this
            always shows the complete enroll/unenroll/re-enroll story. */}
        {enrollmentHistory?.length > 0 && (
          <motion.div variants={item} className="card p-5">
            <h2 className="font-semibold text-slate-900 dark:text-slate-100 mb-3">Enrollment History</h2>
            <ol className="space-y-2.5">
              {enrollmentHistory.map((l) => (
                <li key={l.id} className="flex items-center gap-3 text-sm">
                  <span
                    className={`h-2 w-2 rounded-full shrink-0 ${
                      l.action === 'DEVICE_ENROLLED' ? 'bg-accent-500' : 'bg-orange-500'
                    }`}
                  />
                  <span className="text-slate-700 dark:text-slate-200">
                    {l.action === 'DEVICE_ENROLLED' ? 'Enrolled' : l.action === 'DEVICE_UNENROLLED' ? 'Unenrolled' : l.action.replace(/_/g, ' ')}
                  </span>
                  <span className="text-xs text-slate-400 dark:text-slate-500">
                    {l.actor_type === 'device' ? 'by device' : `by ${l.actor_label || 'admin'}`}
                  </span>
                  <span className="text-xs text-slate-400 dark:text-slate-500 ml-auto">{timeAgo(l.created_at)}</span>
                </li>
              ))}
            </ol>
          </motion.div>
        )}

        {/* Alerts for this device */}
        <motion.div variants={item} className="card">
          <div className="px-5 py-4 border-b border-slate-100 dark:border-slate-800 flex items-center justify-between">
            <h2 className="font-display font-semibold text-slate-900 dark:text-slate-100">Alerts</h2>
            <Link to={`/audit?device=${id}`} className="text-xs text-brand-700 dark:text-brand-300 hover:text-brand-800">
              Full activity log →
            </Link>
          </div>
          {alerts && alerts.length ? (
            <ul className="divide-y divide-slate-100 dark:divide-slate-800">
              {alerts.slice(0, 8).map((a) => (
                <li key={a.id} className="px-5 py-3 flex items-center gap-3">
                  <SeverityBadge severity={a.severity} />
                  <span className="flex-1 text-sm text-slate-700 dark:text-slate-200">{a.message}</span>
                  <span className="text-xs text-slate-400 dark:text-slate-500">{timeAgo(a.created_at)}</span>
                </li>
              ))}
            </ul>
          ) : (
            <div className="text-slate-400 dark:text-slate-500 text-sm py-8 text-center">No alerts for this device</div>
          )}
        </motion.div>

        {/* Command history */}
        <motion.div variants={item} className="card">
          <div className="px-5 py-4 border-b border-slate-100 dark:border-slate-800">
            <h2 className="font-display font-semibold text-slate-900 dark:text-slate-100">Command History</h2>
          </div>
          {commands.length ? (
            <table className="w-full">
              <thead className="bg-slate-50 dark:bg-slate-800/60">
                <tr>
                  <th className="th">Command</th>
                  <th className="th">Status</th>
                  <th className="th">Issued By</th>
                  <th className="th">Issued</th>
                  <th className="th">Result</th>
                </tr>
              </thead>
              <tbody>
                {commands.map((c) => (
                  <tr key={c.id} className="hover:bg-slate-50 dark:hover:bg-slate-800/60">
                    <td className="td font-mono text-brand-700 dark:text-brand-300">{c.type}</td>
                    <td className="td"><StatusBadge status={c.status} /></td>
                    <td className="td text-slate-500 dark:text-slate-400">{c.issued_by_name || 'system'}</td>
                    <td className="td text-slate-400 dark:text-slate-500">{timeAgo(c.issued_at)}</td>
                    <td className="td text-slate-500 dark:text-slate-400 max-w-xs truncate">{c.result || '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : (
            <div className="text-slate-400 dark:text-slate-500 text-sm py-10 text-center">No commands issued yet</div>
          )}
        </motion.div>
      </motion.div>
    </div>
  );
}
