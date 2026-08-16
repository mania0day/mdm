import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from '../api';
import { Spinner, StatusDot, ComplianceDot, OnlineDot, timeAgo, EmptyState } from '../ui.jsx';

export default function Devices() {
  const [devices, setDevices] = useState(null);
  const [alertCounts, setAlertCounts] = useState({});
  const [q, setQ] = useState('');
  const navigate = useNavigate();

  useEffect(() => {
    let live = true;
    const poll = () => api.get('/devices').then((d) => live && setDevices(d.devices)).catch(() => {});
    poll();
    const t = setInterval(poll, 8000);
    return () => {
      live = false;
      clearInterval(t);
    };
  }, []);

  // Per-device unseen-alert counts drive the badge on each row — this is the
  // only place alert counts surface now (no more global sidebar badge).
  // Opening a device's detail page acks its alerts, so this count drops back
  // to 0 as soon as the operator has actually seen them.
  useEffect(() => {
    let live = true;
    const poll = () =>
      api
        .get('/alerts')
        .then((d) => {
          if (!live) return;
          const counts = {};
          for (const a of d.alerts) {
            if (a.device_id && !a.acknowledged) counts[a.device_id] = (counts[a.device_id] || 0) + 1;
          }
          setAlertCounts(counts);
        })
        .catch(() => {});
    poll();
    const t = setInterval(poll, 8000);
    window.addEventListener('sentroid:alerts-changed', poll);
    return () => {
      live = false;
      clearInterval(t);
      window.removeEventListener('sentroid:alerts-changed', poll);
    };
  }, []);

  if (!devices) return <Spinner />;

  const filtered = devices.filter((d) =>
    [d.name, d.model, d.owner_name, d.department, d.device_uid]
      .filter(Boolean)
      .join(' ')
      .toLowerCase()
      .includes(q.toLowerCase()),
  );

  return (
    <div className="space-y-5">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="font-display text-2xl font-bold text-slate-900 dark:text-slate-100">Devices</h1>
          <p className="text-sm text-slate-500 dark:text-slate-400">{devices.length} enrolled device(s)</p>
        </div>
        <input
          className="input max-w-xs"
          placeholder="Search devices…"
          value={q}
          onChange={(e) => setQ(e.target.value)}
        />
      </div>

      <div className="card overflow-hidden">
        {filtered.length ? (
          <table className="w-full">
            <thead>
              <tr className="bg-slate-50 dark:bg-slate-800/60">
                <th className="th">Device</th>
                <th className="th">Owner / Dept</th>
                <th className="th">Status</th>
                <th className="th">Compliance</th>
                <th className="th">Battery</th>
                <th className="th">Connectivity</th>
                <th className="th">Last Seen</th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((d) => (
                <tr
                  key={d.id}
                  className="cursor-pointer border-t border-slate-100 dark:border-slate-800 hover:bg-slate-50 dark:hover:bg-slate-800/60 transition-colors"
                  onClick={() => navigate(`/devices/${d.id}`)}
                >
                  <td className="td">
                    <div className="font-medium text-slate-800 dark:text-slate-100 flex items-center gap-1.5">
                      {d.name}
                      {d.is_rooted ? (
                        <span title="Rooted — compromised integrity" className="text-red-600 dark:text-red-400">⚠</span>
                      ) : null}
                      {alertCounts[d.id] ? (
                        <span
                          title={`${alertCounts[d.id]} unseen alert(s)`}
                          className="badge bg-red-100 text-red-700 ring-1 ring-red-600/20 dark:bg-red-500/15 dark:text-red-300 dark:ring-red-400/25"
                        >
                          {alertCounts[d.id]}
                        </span>
                      ) : null}
                    </div>
                    <div className="text-xs text-slate-500 dark:text-slate-400 font-mono">{d.model || d.device_uid}</div>
                  </td>
                  <td className="td">
                    <div className="text-slate-800 dark:text-slate-100">{d.owner_name || '—'}</div>
                    <div className="text-xs text-slate-500 dark:text-slate-400">{d.department || ''}</div>
                  </td>
                  <td className="td"><StatusDot status={d.status} /></td>
                  <td className="td"><ComplianceDot value={d.compliance} /></td>
                  <td className="td">
                    {d.battery_level != null ? (
                      <span className={d.battery_level <= 15 ? 'text-red-700 dark:text-red-300' : 'text-slate-800 dark:text-slate-100'}>
                        {d.battery_level}%{d.battery_charging ? ' ⚡' : ''}
                      </span>
                    ) : (
                      '—'
                    )}
                  </td>
                  <td className="td text-slate-500 dark:text-slate-400">{d.network_type || '—'}</td>
                  <td className="td">
                    <OnlineDot online={d.online} />
                    <div className="text-xs text-slate-400 dark:text-slate-500">{timeAgo(d.last_seen)}</div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <EmptyState>
            {devices.length === 0
              ? 'No devices enrolled yet. Generate an enrollment token and install the SENTROID agent.'
              : 'No devices match your search.'}
          </EmptyState>
        )}
      </div>
    </div>
  );
}
