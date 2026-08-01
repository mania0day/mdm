import { useEffect, useState } from 'react';
import { motion } from 'framer-motion';
import { api } from '../api';
import { Spinner, timeAgo, EmptyState } from '../ui.jsx';

const rowVariants = {
  hidden: { opacity: 0, y: 8 },
  show: { opacity: 1, y: 0, transition: { duration: 0.25, ease: 'easeOut' } },
};
const listVariants = {
  hidden: {},
  show: { transition: { staggerChildren: 0.05 } },
};

export default function Enrollment() {
  const [tokens, setTokens] = useState(null);
  const [label, setLabel] = useState('');
  const [department, setDepartment] = useState('');
  const [copied, setCopied] = useState('');

  const load = () => api.get('/enrollment/tokens').then((d) => setTokens(d.tokens)).catch(() => {});
  useEffect(() => { load(); }, []);

  async function create() {
    await api.post('/enrollment/tokens', {
      label: label || undefined,
      department: department || undefined,
    });
    setLabel('');
    setDepartment('');
    load();
  }
  async function remove(id) {
    await api.del(`/enrollment/tokens/${id}`);
    load();
  }
  function copy(t) {
    navigator.clipboard?.writeText(t);
    setCopied(t);
    setTimeout(() => setCopied(''), 1500);
  }

  if (!tokens) return <Spinner />;

  return (
    <div className="space-y-5">
      <div>
        <h1 className="h-page font-display text-brand-800 dark:text-slate-100">Device Enrollment</h1>
        <p className="text-sm text-slate-500 dark:text-slate-400">
          Generate single-use tokens. Enter a token in the SENTROID Android agent to onboard a device.
        </p>
      </div>

      <motion.div
        className="card p-5"
        initial={{ opacity: 0, y: 10 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.3, ease: 'easeOut' }}
      >
        <h2 className="font-display font-semibold text-brand-800 dark:text-slate-100 mb-3">Generate Enrollment Token</h2>
        <div className="flex flex-wrap gap-3 items-end">
          <div className="flex-1 min-w-[10rem]">
            <label className="label">Owner / Label (optional)</label>
            <input className="input" value={label} onChange={(e) => setLabel(e.target.value)} placeholder="e.g. Officer J. Khan" />
          </div>
          <div className="flex-1 min-w-[10rem]">
            <label className="label">Department (optional)</label>
            <input className="input" value={department} onChange={(e) => setDepartment(e.target.value)} placeholder="e.g. Field Operations" />
          </div>
          <button className="btn-primary" onClick={create}>Generate</button>
        </div>
      </motion.div>

      <div className="card overflow-hidden">
        {tokens.length ? (
          <table className="w-full">
            <thead>
              <tr>
                <th className="th">Token</th>
                <th className="th">Label</th>
                <th className="th">Dept</th>
                <th className="th">Status</th>
                <th className="th">Created</th>
                <th className="th"></th>
              </tr>
            </thead>
            <motion.tbody variants={listVariants} initial="hidden" animate="show">
              {tokens.map((t) => (
                <motion.tr key={t.id} variants={rowVariants}>
                  <td className="td">
                    <div className="inline-flex items-center gap-2 rounded-lg bg-slate-50 border border-slate-200 dark:bg-slate-800/60 dark:border-slate-700 px-2.5 py-1.5">
                      <span className="font-mono text-sm text-slate-700 dark:text-slate-200">{t.token}</span>
                      <button
                        className="btn-ghost px-2 py-1 text-xs inline-flex items-center gap-1"
                        onClick={() => copy(t.token)}
                        title="Copy token"
                      >
                        {copied === t.token ? (
                          <motion.span
                            key="copied"
                            initial={{ scale: 0.8, opacity: 0 }}
                            animate={{ scale: 1, opacity: 1 }}
                            transition={{ duration: 0.2, ease: 'easeOut' }}
                            className="inline-flex items-center gap-1 text-accent-700 dark:text-accent-300"
                          >
                            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                              <polyline points="20 6 9 17 4 12" />
                            </svg>
                            Copied
                          </motion.span>
                        ) : (
                          <span className="inline-flex items-center gap-1 text-slate-500 dark:text-slate-400">
                            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                              <rect x="9" y="9" width="13" height="13" rx="2" ry="2" />
                              <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
                            </svg>
                            Copy
                          </span>
                        )}
                      </button>
                    </div>
                  </td>
                  <td className="td text-slate-800 dark:text-slate-100">{t.label || '—'}</td>
                  <td className="td text-slate-500 dark:text-slate-400">{t.department || '—'}</td>
                  <td className="td">
                    {t.used ? (
                      <span className="badge bg-slate-100 text-slate-600 dark:bg-slate-700/50 dark:text-slate-300">
                        used → {t.device_name || `#${t.device_id}`}
                      </span>
                    ) : (
                      <span className="badge bg-accent-100 text-accent-700 dark:bg-accent-500/15 dark:text-accent-300">available</span>
                    )}
                  </td>
                  <td className="td text-slate-400 dark:text-slate-500">{timeAgo(t.created_at)}</td>
                  <td className="td text-right">
                    {!t.used && (
                      <button className="btn-ghost text-xs text-red-600 hover:text-red-700 dark:text-red-400 dark:hover:text-red-300" onClick={() => remove(t.id)}>Revoke</button>
                    )}
                  </td>
                </motion.tr>
              ))}
            </motion.tbody>
          </table>
        ) : (
          <EmptyState>No enrollment tokens. Generate one above.</EmptyState>
        )}
      </div>
    </div>
  );
}
