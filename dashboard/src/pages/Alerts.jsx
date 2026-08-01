import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { motion } from 'framer-motion';
import { api } from '../api';
import { Spinner, SeverityBadge, timeAgo, EmptyState } from '../ui.jsx';

const listVariants = {
  hidden: {},
  show: { transition: { staggerChildren: 0.04 } },
};

const itemVariants = {
  hidden: { opacity: 0, y: 10 },
  show: { opacity: 1, y: 0, transition: { duration: 0.25, ease: 'easeOut' } },
};

export default function Alerts() {
  const [data, setData] = useState(null);

  const load = () => api.get('/alerts').then(setData).catch(() => {});
  useEffect(() => {
    load();
    const t = setInterval(load, 8000);
    return () => clearInterval(t);
  }, []);

  async function ack(id) {
    await api.post(`/alerts/${id}/ack`);
    load();
  }
  async function ackAll() {
    await api.post('/alerts/ack-all');
    load();
  }

  if (!data) return <Spinner />;

  const accentFor = (a) => {
    if (a.acknowledged) return 'border-l-4 border-transparent';
    if (a.severity === 'critical') return 'border-l-4 border-red-500';
    if (a.severity === 'warning') return 'border-l-4 border-amber-400';
    return 'border-l-4 border-brand-400';
  };

  return (
    <div className="space-y-5">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="font-display text-2xl font-bold text-brand-800 dark:text-slate-100">Alerts</h1>
          <p className="text-sm text-slate-500 dark:text-slate-400">{data.unacknowledged} unacknowledged</p>
        </div>
        {data.unacknowledged > 0 && (
          <button className="btn-accent" onClick={ackAll}>Acknowledge all</button>
        )}
      </div>

      <div className="card overflow-hidden">
        {data.alerts.length ? (
          <table className="w-full">
            <thead>
              <tr>
                <th className="th">Severity</th>
                <th className="th">Type</th>
                <th className="th">Message</th>
                <th className="th">Device</th>
                <th className="th">When</th>
                <th className="th"></th>
              </tr>
            </thead>
            <motion.tbody variants={listVariants} initial="hidden" animate="show">
              {data.alerts.map((a) => {
                const criticalUnack = !a.acknowledged && a.severity === 'critical';
                return (
                  <motion.tr
                    key={a.id}
                    variants={itemVariants}
                    className={`${accentFor(a)} ${a.acknowledged ? 'opacity-50' : ''}`}
                  >
                    <td className="td">
                      <div className="flex items-center gap-2">
                        {criticalUnack && (
                          <motion.span
                            className="inline-block h-2 w-2 rounded-full bg-red-500"
                            animate={{ opacity: [1, 0.4, 1] }}
                            transition={{ duration: 1.4, repeat: Infinity, ease: 'easeInOut' }}
                          />
                        )}
                        <SeverityBadge severity={a.severity} />
                      </div>
                    </td>
                    <td className="td font-mono text-xs text-slate-500 dark:text-slate-400">{a.type}</td>
                    <td className="td text-slate-800 dark:text-slate-100">{a.message}</td>
                    <td className="td">
                      {a.device_id ? (
                        <Link to={`/devices/${a.device_id}`} className="text-brand-600 hover:text-brand-700 dark:text-brand-300 dark:hover:text-brand-300">
                          {a.device_name || `#${a.device_id}`}
                        </Link>
                      ) : '—'}
                    </td>
                    <td className="td text-slate-500 dark:text-slate-400">{timeAgo(a.created_at)}</td>
                    <td className="td text-right">
                      {!a.acknowledged && (
                        <button className="btn-ghost text-xs" onClick={() => ack(a.id)}>Ack</button>
                      )}
                    </td>
                  </motion.tr>
                );
              })}
            </motion.tbody>
          </table>
        ) : (
          <EmptyState>No alerts. All clear.</EmptyState>
        )}
      </div>
    </div>
  );
}
