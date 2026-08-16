import { useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { api } from '../api';
import { Spinner, SeverityBadge, timeAgo, EmptyState, notifyAlertsChanged } from '../ui.jsx';

const REFRESH_MS = 8000;

// "See all" first, then one tab per severity. Counts are filled in from the
// loaded alerts so each tab shows how many it holds.
const TABS = [
  { key: 'all', label: 'See all' },
  { key: 'critical', label: 'Critical' },
  { key: 'warning', label: 'Warning' },
  { key: 'info', label: 'Info' },
];

export default function Alerts() {
  const [params, setParams] = useSearchParams();
  const deviceId = params.get('device');
  const [alerts, setAlerts] = useState(null);
  const [tab, setTab] = useState('all');

  // Load alerts — fleet-wide, or scoped to one device via ?device=.
  useEffect(() => {
    let live = true;
    const qs = deviceId ? `?device_id=${deviceId}` : '';
    const load = () =>
      api.get(`/alerts${qs}`).then((d) => live && setAlerts(d.alerts)).catch(() => {});
    load();
    const t = setInterval(load, REFRESH_MS);
    return () => {
      live = false;
      clearInterval(t);
    };
  }, [deviceId]);

  // Opening this page marks everything shown as seen, so the sidebar's "new
  // alerts" badge resets to 0 (same pattern DeviceDetail already uses). Alerts
  // that arrive afterwards are unacknowledged again and re-raise the badge.
  useEffect(() => {
    const qs = deviceId ? `?device_id=${deviceId}` : '';
    api.post(`/alerts/ack-all${qs}`).then(() => notifyAlertsChanged()).catch(() => {});
  }, [deviceId]);

  const counts = useMemo(() => {
    const c = { all: 0, critical: 0, warning: 0, info: 0 };
    (alerts || []).forEach((a) => {
      c.all += 1;
      if (c[a.severity] != null) c[a.severity] += 1;
    });
    return c;
  }, [alerts]);

  const shown = (alerts || []).filter((a) => tab === 'all' || a.severity === tab);
  const deviceName = deviceId && alerts && alerts.find((a) => a.device_name)?.device_name;

  return (
    <div className="space-y-5">
      <div>
        {deviceId ? (
          <>
            <button
              onClick={() => setParams({})}
              className="text-xs text-brand-600 dark:text-brand-300 hover:text-brand-800 mb-1"
            >
              ← All alerts
            </button>
            <h1 className="text-2xl font-bold text-slate-900 dark:text-slate-100">
              {deviceName || 'Device'} — Alerts
            </h1>
          </>
        ) : (
          <h1 className="text-2xl font-bold text-slate-900 dark:text-slate-100">Alerts</h1>
        )}
        <p className="text-sm text-slate-500 dark:text-slate-400">
          Monitoring events across the fleet — newest first
        </p>
      </div>

      {/* Severity tabs */}
      <div className="inline-flex flex-wrap gap-0.5 rounded-lg border border-slate-200 dark:border-slate-700 p-0.5 bg-white dark:bg-slate-900">
        {TABS.map((t) => (
          <button
            key={t.key}
            onClick={() => setTab(t.key)}
            className={`px-3.5 py-1.5 text-sm rounded-md inline-flex items-center gap-2 transition-colors ${
              tab === t.key
                ? 'bg-brand-600 text-white'
                : 'text-slate-600 dark:text-slate-300 hover:text-slate-900 dark:hover:text-white'
            }`}
          >
            {t.label}
            <span
              className={`text-xs rounded-full px-1.5 py-0.5 tabular-nums ${
                tab === t.key ? 'bg-white/20' : 'bg-slate-100 dark:bg-slate-800'
              }`}
            >
              {counts[t.key] || 0}
            </span>
          </button>
        ))}
      </div>

      <div className="card overflow-hidden">
        {!alerts ? (
          <Spinner />
        ) : shown.length ? (
          <table className="w-full">
            <thead>
              <tr className="bg-slate-50 dark:bg-slate-800/60">
                <th className="th">Severity</th>
                {!deviceId && <th className="th">Device</th>}
                <th className="th">Type</th>
                <th className="th">Message</th>
                <th className="th">When</th>
              </tr>
            </thead>
            <tbody>
              {shown.map((a) => (
                <tr
                  key={a.id}
                  className="border-t border-slate-100 dark:border-slate-800 hover:bg-slate-50 dark:hover:bg-slate-800/60"
                >
                  <td className="td"><SeverityBadge severity={a.severity} /></td>
                  {!deviceId && (
                    <td className="td text-slate-700 dark:text-slate-200">{a.device_name || '—'}</td>
                  )}
                  <td className="td font-mono text-xs text-slate-500 dark:text-slate-400">{a.type}</td>
                  <td className="td text-slate-800 dark:text-slate-100">{a.message}</td>
                  <td className="td text-slate-500 dark:text-slate-400 whitespace-nowrap">
                    {timeAgo(a.created_at)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <EmptyState>
            No {tab === 'all' ? '' : `${tab} `}alerts{deviceId ? ' for this device' : ''}.
          </EmptyState>
        )}
      </div>
    </div>
  );
}
