import { useEffect, useState } from 'react';
import { motion } from 'framer-motion';
import { api } from '../api';
import { Spinner, timeAgo, EmptyState } from '../ui.jsx';

const listVariants = {
  hidden: {},
  show: { transition: { staggerChildren: 0.03 } },
};

const rowVariants = {
  hidden: { opacity: 0, y: 8 },
  show: { opacity: 1, y: 0, transition: { duration: 0.2 } },
};

export default function AuditLogs() {
  const [logs, setLogs] = useState(null);
  const [filter, setFilter] = useState('');

  const load = (f) => {
    const qs = f ? `?action=${encodeURIComponent(f)}` : '';
    api.get(`/audit-logs${qs}`).then((d) => setLogs(d.logs)).catch(() => {});
  };
  useEffect(() => { load(''); }, []);

  if (!logs) return <Spinner />;

  return (
    <div className="space-y-5">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold font-display text-brand-800 dark:text-slate-100">Audit Logs</h1>
          <p className="text-sm text-slate-500 dark:text-slate-400">Accountability trail of all administrative and device actions</p>
        </div>
        <div className="flex gap-2">
          <input
            className="input max-w-xs"
            placeholder="Filter by action (e.g. COMMAND_WIPE)"
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && load(filter)}
          />
          <button className="btn-ghost" onClick={() => load(filter)}>Filter</button>
        </div>
      </div>

      <div className="card overflow-hidden">
        {logs.length ? (
          <table className="w-full">
            <thead>
              <tr className="bg-slate-50 dark:bg-slate-800/60">
                <th className="th">Time</th>
                <th className="th">Actor</th>
                <th className="th">Action</th>
                <th className="th">Target</th>
                <th className="th">Details</th>
                <th className="th">IP</th>
              </tr>
            </thead>
            <motion.tbody variants={listVariants} initial="hidden" animate="show">
              {logs.map((l) => (
                <motion.tr key={l.id} variants={rowVariants} className="border-t border-slate-100 dark:border-slate-800 hover:bg-slate-50 dark:hover:bg-slate-800/60 transition-colors">
                  <td className="td text-slate-400 dark:text-slate-500 whitespace-nowrap">{timeAgo(l.created_at)}</td>
                  <td className="td">
                    <span className={`badge ${l.actor_type === 'device' ? 'bg-sky-50 text-sky-700 dark:bg-sky-500/15 dark:text-sky-300' : 'bg-brand-50 text-brand-700 dark:bg-brand-500/15 dark:text-brand-300'}`}>
                      {l.actor_type}
                    </span>
                    <span className="ml-2 text-slate-700 dark:text-slate-200">{l.actor_label || '—'}</span>
                  </td>
                  <td className="td">
                    <span className="badge bg-brand-50 text-brand-700 dark:bg-brand-500/15 dark:text-brand-300 font-mono text-xs">{l.action}</span>
                  </td>
                  <td className="td text-slate-500 dark:text-slate-400 text-xs">
                    {l.target_type ? `${l.target_type}#${l.target_id}` : '—'}
                  </td>
                  <td className="td text-xs text-slate-400 dark:text-slate-500 max-w-sm truncate">
                    {l.details ? JSON.stringify(l.details) : '—'}
                  </td>
                  <td className="td text-xs text-slate-400 dark:text-slate-500 font-mono">{l.ip || '—'}</td>
                </motion.tr>
              ))}
            </motion.tbody>
          </table>
        ) : (
          <EmptyState>No audit entries yet.</EmptyState>
        )}
      </div>
    </div>
  );
}
