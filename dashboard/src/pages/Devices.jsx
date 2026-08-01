import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { motion } from 'framer-motion';
import { api } from '../api';
import { Spinner, StatusBadge, ComplianceBadge, OnlineDot, timeAgo, EmptyState } from '../ui.jsx';

const container = {
  hidden: {},
  show: { transition: { staggerChildren: 0.04 } },
};

const item = {
  hidden: { opacity: 0, y: 10 },
  show: { opacity: 1, y: 0, transition: { duration: 0.35, ease: 'easeOut' } },
};

export default function Devices() {
  const [devices, setDevices] = useState(null);
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
          <h1 className="font-display text-2xl font-bold text-brand-800 dark:text-slate-100">Devices</h1>
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
            <motion.tbody variants={container} initial="hidden" animate="show">
              {filtered.map((d) => (
                <motion.tr
                  key={d.id}
                  variants={item}
                  whileHover={{ backgroundColor: 'rgb(248 250 252)' }}
                  transition={{ duration: 0.3, ease: 'easeOut' }}
                  className="cursor-pointer border-t border-slate-100 dark:border-slate-800"
                  onClick={() => navigate(`/devices/${d.id}`)}
                >
                  <td className="td">
                    <div className="font-medium text-slate-800 dark:text-slate-100">{d.name}</div>
                    <div className="text-xs text-slate-500 dark:text-slate-400 font-mono">{d.model || d.device_uid}</div>
                  </td>
                  <td className="td">
                    <div className="text-slate-800 dark:text-slate-100">{d.owner_name || '—'}</div>
                    <div className="text-xs text-slate-500 dark:text-slate-400">{d.department || ''}</div>
                  </td>
                  <td className="td"><StatusBadge status={d.status} /></td>
                  <td className="td"><ComplianceBadge value={d.compliance} /></td>
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
                </motion.tr>
              ))}
            </motion.tbody>
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
