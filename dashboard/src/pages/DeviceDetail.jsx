import { useEffect, useState, useCallback } from 'react';
import { useParams, useNavigate, Link } from 'react-router-dom';
import { motion } from 'framer-motion';
import { api } from '../api';
import { useAuth, hasRole } from '../auth.jsx';
import { Spinner, StatusBadge, ComplianceBadge, OnlineDot, timeAgo } from '../ui.jsx';

// Remote commands surfaced as buttons, mirroring server COMMAND_TYPES.
const COMMANDS = [
  { type: 'LOCK', label: 'Lock', variant: 'ghost', role: 'operator', confirm: false },
  { type: 'UNLOCK', label: 'Unlock', variant: 'ghost', role: 'operator', confirm: false },
  { type: 'PING', label: 'Ping', variant: 'ghost', role: 'operator', confirm: false },
  { type: 'LOCATE', label: 'Locate', variant: 'ghost', role: 'operator', confirm: false },
  { type: 'RING', label: 'Ring', variant: 'ghost', role: 'operator', confirm: false },
  { type: 'ENFORCE_POLICY', label: 'Re-enforce Policy', variant: 'ghost', role: 'admin', confirm: false },
  { type: 'DISABLE', label: 'Disable Device', variant: 'danger', role: 'admin', confirm: true },
  { type: 'ENABLE', label: 'Re-enable', variant: 'ghost', role: 'admin', confirm: false },
  { type: 'WIPE', label: 'Factory Wipe', variant: 'danger', role: 'admin', confirm: true },
];

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
  const [busy, setBusy] = useState('');
  const [toast, setToast] = useState('');

  const load = useCallback(() => {
    api.get(`/devices/${id}`).then(setData).catch(() => navigate('/devices'));
  }, [id, navigate]);

  useEffect(() => {
    load();
    api.get('/policies').then((d) => setPolicies(d.policies)).catch(() => {});
    const t = setInterval(load, 6000);
    return () => clearInterval(t);
  }, [load]);

  if (!data) return <Spinner />;
  const { device, policy, commands } = data;

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
    if (!confirm(`Deregister ${device.name}? This removes it from management.`)) return;
    try {
      await api.del(`/devices/${id}`);
      navigate('/devices');
    } catch (e) {
      setToast(`Deregister failed: ${e.message}`);
      setTimeout(() => setToast(''), 5000);
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
            <h1 className="font-display text-2xl font-bold text-brand-800 dark:text-slate-100">{device.name}</h1>
            <StatusBadge status={device.status} />
            <ComplianceBadge value={device.compliance} />
          </div>
          <div className="mt-1 flex items-center gap-3 text-sm text-slate-500 dark:text-slate-400">
            <OnlineDot online={device.online} />
            <span>· last seen {timeAgo(device.last_seen)}</span>
          </div>
        </div>
        {hasRole(user, 'admin') && (
          <button onClick={deregister} className="btn-danger">
            Deregister
          </button>
        )}
      </div>

      <motion.div variants={container} initial="hidden" animate="show" className="space-y-6">
        {/* Remote command bar */}
        <motion.div variants={item} className="card p-5">
          <h2 className="font-display font-semibold text-brand-800 dark:text-slate-100 mb-3">Remote Actions</h2>
          <div className="flex flex-wrap gap-2">
            {COMMANDS.filter((c) => hasRole(user, c.role)).map((c) => (
              <motion.button
                key={c.type}
                onClick={() => sendCommand(c)}
                disabled={busy === c.type}
                whileTap={{ scale: 0.95 }}
                className={c.variant === 'danger' ? 'btn-danger' : 'btn-ghost'}
              >
                {busy === c.type ? '…' : c.label}
              </motion.button>
            ))}
          </div>
          <p className="text-xs text-slate-400 dark:text-slate-500 mt-3">
            Commands are queued securely and executed by the agent on its next check-in
            (~10s). Destructive actions require an admin role.
          </p>
        </motion.div>

        <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
          {/* Device info */}
          <motion.div variants={item} className="card p-5 lg:col-span-2">
            <h2 className="font-display font-semibold text-brand-800 dark:text-slate-100 mb-4">Device Information</h2>
            <div className="grid grid-cols-2 md:grid-cols-3 gap-4">
              <Info label="Manufacturer" value={device.manufacturer} />
              <Info label="Model" value={device.model} />
              <Info label="Android" value={device.os_version ? `${device.os_version} (API ${device.sdk_int || '?'})` : null} />
              <Info label="Owner" value={device.owner_name} />
              <Info label="Department" value={device.department} />
              <Info label="Serial" value={device.serial} mono />
              <Info label="Device UID" value={device.device_uid} mono />
              <Info label="Admin Active" value={device.admin_active ? 'Yes' : 'No'} />
              <Info label="Encryption" value={device.encryption_on ? 'On' : 'Off/Unknown'} />
              <Info label="Rooted" value={device.is_rooted ? '⚠ Yes' : 'No'} />
              <Info label="Battery" value={device.battery_level != null ? `${device.battery_level}%${device.battery_charging ? ' ⚡' : ''}` : null} />
              <Info label="Network" value={device.network_type} />
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
            <h2 className="font-display font-semibold text-brand-800 dark:text-slate-100 mb-4">Assigned Policy</h2>
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
            <dl className="space-y-1.5 text-sm">
              {Object.entries(policy.config).map(([k, v]) => (
                <div key={k} className="flex justify-between gap-2">
                  <dt className="text-slate-500 dark:text-slate-400">{k.replace(/_/g, ' ')}</dt>
                  <dd className="text-slate-700 dark:text-slate-200 font-mono">{String(v)}</dd>
                </div>
              ))}
            </dl>
          </motion.div>
        </div>

        {/* Command history */}
        <motion.div variants={item} className="card">
          <div className="px-5 py-4 border-b border-slate-100 dark:border-slate-800">
            <h2 className="font-display font-semibold text-brand-800 dark:text-slate-100">Command History</h2>
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
